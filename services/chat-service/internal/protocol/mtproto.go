// Package protocol defines the Uninet chat wire protocol.
//
// Two encodings carry the same Frame model:
//
//  1. JSON text frames (default, easiest for browsers).
//  2. A compact binary transport inspired by MTProto's "abridged"/"intermediate" transports
//     (length-prefixed envelopes, typed TLV fields, raw binary instead of base64, CRC32 integrity).
//     Select it per connection with ?proto=binary. It is NOT the Telegram MTProto cryptographic
//     protocol: confidentiality comes from the clients' end-to-end encryption plus TLS.
//
// Binary envelope (all integers big endian):
//
//	magic(1)=0xA7 | version(1)=1 | type(1) | flags(1) | payloadLen(4) | payload | crc32(4)
//
// payload is a sequence of fields: id(1) | length(uvarint) | value. The CRC covers every byte before it.
package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"

	"github.com/google/uuid"
)

// Frame types.
const (
	TypePing          = "ping"
	TypePong          = "pong"
	TypeMessage       = "message"        // encrypted payload relay (both directions)
	TypeAck           = "ack"            // server -> client: result of a client frame
	TypeTyping        = "typing"         // relayed, never queued
	TypeReceipt       = "receipt"        // delivered / read
	TypeKeysPublish   = "keys.publish"   // client -> server
	TypeKeysFetch     = "keys.fetch"     // client -> server
	TypeKeysBundle    = "keys.bundle"    // server -> client
	TypePresenceQuery = "presence.query" // client -> server
	TypePresence      = "presence"       // server -> client
	TypeHistoryFetch  = "history.fetch"  // client -> server; replies are message frames with status "history"
	TypeError         = "error"          // server -> client
)

// Frame is the single envelope used in both directions. Unused fields are omitted.
type Frame struct {
	Type           string      `json:"type"`
	ID             string      `json:"id,omitempty"`              // client generated, unique per message
	From           string      `json:"from,omitempty"`            // set by the server, never trusted from clients
	To             string      `json:"to,omitempty"`              // recipient user id (uuid)
	ConversationID string      `json:"conversation_id,omitempty"` // opaque to the server
	Header         string      `json:"header,omitempty"`          // opaque session header
	Ciphertext     string      `json:"ciphertext,omitempty"`      // base64, opaque to the server
	Status         string      `json:"status,omitempty"`
	MessageID      string      `json:"message_id,omitempty"`
	ServerTS       int64       `json:"server_ts,omitempty"` // unix milliseconds
	UserID         string      `json:"user_id,omitempty"`
	Online         *bool       `json:"online,omitempty"`
	Limit          uint16      `json:"limit,omitempty"`
	Keys           *KeyBundle  `json:"keys,omitempty"`
	Error          *FrameError `json:"error,omitempty"`
}

type FrameError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type KeyBundle struct {
	IdentityKey     string   `json:"identity_key"`
	SignedPrekey    string   `json:"signed_prekey"`
	SignedPrekeySig string   `json:"signed_prekey_signature"`
	OneTimePrekeys  []string `json:"one_time_prekeys,omitempty"` // publish only
	OneTimePrekey   string   `json:"one_time_prekey,omitempty"`  // fetch response only
}

/* ------------------------------------------------------------------ */
/* Validators                                                          */
/* ------------------------------------------------------------------ */

// ValidID reports whether s is a 1-64 character identifier of [A-Za-z0-9_-].
func ValidID(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// ValidBase64 reports whether s is non-empty, at most maxChars long and valid standard base64.
func ValidBase64(s string, maxChars int) bool {
	if len(s) == 0 || len(s) > maxChars {
		return false
	}
	_, err := base64.StdEncoding.DecodeString(s)
	return err == nil
}

// NormalizeUserID parses a UUID and returns its canonical lowercase form.
func NormalizeUserID(s string) (string, bool) {
	id, err := uuid.Parse(s)
	if err != nil {
		return "", false
	}
	return id.String(), true
}

/* ------------------------------------------------------------------ */
/* Binary transport                                                    */
/* ------------------------------------------------------------------ */

const (
	// BinaryMagic is the first byte of every binary envelope.
	BinaryMagic byte = 0xA7
	// BinaryVersion is the supported envelope version.
	BinaryVersion byte = 1

	headerSize  = 8
	trailerSize = 4
)

// ErrBinaryFormat is returned for malformed binary envelopes.
var ErrBinaryFormat = errors.New("protocol: malformed binary frame")

var typeToCode = map[string]byte{
	TypePing: 1, TypePong: 2, TypeMessage: 3, TypeAck: 4, TypeTyping: 5, TypeReceipt: 6,
	TypeKeysPublish: 7, TypeKeysFetch: 8, TypeKeysBundle: 9, TypePresenceQuery: 10,
	TypePresence: 11, TypeError: 12, TypeHistoryFetch: 13,
}

var codeToType = func() map[byte]string {
	m := make(map[byte]string, len(typeToCode))
	for k, v := range typeToCode {
		m[v] = k
	}
	return m
}()

// Field identifiers inside the binary payload.
const (
	fID byte = iota + 1
	fFrom
	fTo
	fConversationID
	fHeader
	fCiphertext
	fStatus
	fMessageID
	fServerTS
	fUserID
	fOnline
	fLimit
	fIdentityKey
	fSignedPrekey
	fSignedPrekeySig
	fOneTimePrekeys // repeated
	fOneTimePrekey
	fErrCode
	fErrMessage
)

func putField(buf *bytes.Buffer, id byte, value []byte) {
	var lenBuf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(lenBuf[:], uint64(len(value)))
	buf.WriteByte(id)
	buf.Write(lenBuf[:n])
	buf.Write(value)
}

func putString(buf *bytes.Buffer, id byte, s string) {
	if s != "" {
		putField(buf, id, []byte(s))
	}
}

func putUUID(buf *bytes.Buffer, id byte, s string) error {
	if s == "" {
		return nil
	}
	u, err := uuid.Parse(s)
	if err != nil {
		return fmt.Errorf("protocol: field %d is not a uuid: %w", id, err)
	}
	putField(buf, id, u[:])
	return nil
}

func putBase64(buf *bytes.Buffer, id byte, s string) error {
	if s == "" {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return fmt.Errorf("protocol: field %d is not base64: %w", id, err)
	}
	putField(buf, id, raw)
	return nil
}

// EncodeBinary serialises a frame into the binary envelope.
func EncodeBinary(f *Frame) ([]byte, error) {
	code, ok := typeToCode[f.Type]
	if !ok {
		return nil, fmt.Errorf("protocol: unknown frame type %q", f.Type)
	}

	var body bytes.Buffer
	putString(&body, fID, f.ID)
	if err := putUUID(&body, fFrom, f.From); err != nil {
		return nil, err
	}
	if err := putUUID(&body, fTo, f.To); err != nil {
		return nil, err
	}
	putString(&body, fConversationID, f.ConversationID)
	putString(&body, fHeader, f.Header)
	if err := putBase64(&body, fCiphertext, f.Ciphertext); err != nil {
		return nil, err
	}
	putString(&body, fStatus, f.Status)
	putString(&body, fMessageID, f.MessageID)
	if f.ServerTS != 0 {
		var ts [8]byte
		binary.BigEndian.PutUint64(ts[:], uint64(f.ServerTS))
		putField(&body, fServerTS, ts[:])
	}
	if err := putUUID(&body, fUserID, f.UserID); err != nil {
		return nil, err
	}
	if f.Online != nil {
		v := byte(0)
		if *f.Online {
			v = 1
		}
		putField(&body, fOnline, []byte{v})
	}
	if f.Limit != 0 {
		var l [2]byte
		binary.BigEndian.PutUint16(l[:], f.Limit)
		putField(&body, fLimit, l[:])
	}
	if k := f.Keys; k != nil {
		if err := putBase64(&body, fIdentityKey, k.IdentityKey); err != nil {
			return nil, err
		}
		if err := putBase64(&body, fSignedPrekey, k.SignedPrekey); err != nil {
			return nil, err
		}
		if err := putBase64(&body, fSignedPrekeySig, k.SignedPrekeySig); err != nil {
			return nil, err
		}
		for _, otpk := range k.OneTimePrekeys {
			if err := putBase64(&body, fOneTimePrekeys, otpk); err != nil {
				return nil, err
			}
		}
		if err := putBase64(&body, fOneTimePrekey, k.OneTimePrekey); err != nil {
			return nil, err
		}
	}
	if e := f.Error; e != nil {
		putString(&body, fErrCode, e.Code)
		putString(&body, fErrMessage, e.Message)
	}

	out := make([]byte, 0, headerSize+body.Len()+trailerSize)
	out = append(out, BinaryMagic, BinaryVersion, code, 0)
	out = binary.BigEndian.AppendUint32(out, uint32(body.Len()))
	out = append(out, body.Bytes()...)
	out = binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(out))
	return out, nil
}

func uuidString(raw []byte) (string, error) {
	u, err := uuid.FromBytes(raw)
	if err != nil {
		return "", ErrBinaryFormat
	}
	return u.String(), nil
}

// DecodeBinary parses a binary envelope into a frame, validating length and CRC.
func DecodeBinary(data []byte) (*Frame, error) {
	if len(data) < headerSize+trailerSize {
		return nil, ErrBinaryFormat
	}
	if data[0] != BinaryMagic || data[1] != BinaryVersion {
		return nil, ErrBinaryFormat
	}
	frameType, ok := codeToType[data[2]]
	if !ok {
		return nil, ErrBinaryFormat
	}
	payloadLen := int(binary.BigEndian.Uint32(data[4:8]))
	if payloadLen != len(data)-headerSize-trailerSize {
		return nil, ErrBinaryFormat
	}
	crcOffset := len(data) - trailerSize
	if crc32.ChecksumIEEE(data[:crcOffset]) != binary.BigEndian.Uint32(data[crcOffset:]) {
		return nil, fmt.Errorf("%w: checksum mismatch", ErrBinaryFormat)
	}

	f := &Frame{Type: frameType}
	r := bytes.NewReader(data[headerSize:crcOffset])
	for r.Len() > 0 {
		id, err := r.ReadByte()
		if err != nil {
			return nil, ErrBinaryFormat
		}
		length, err := binary.ReadUvarint(r)
		if err != nil || length > uint64(r.Len()) {
			return nil, ErrBinaryFormat
		}
		value := make([]byte, length)
		if _, err := io.ReadFull(r, value); err != nil {
			return nil, ErrBinaryFormat
		}
		if err := f.setField(id, value); err != nil {
			return nil, err
		}
	}
	return f, nil
}

func (f *Frame) keys() *KeyBundle {
	if f.Keys == nil {
		f.Keys = &KeyBundle{}
	}
	return f.Keys
}

func (f *Frame) errorInfo() *FrameError {
	if f.Error == nil {
		f.Error = &FrameError{}
	}
	return f.Error
}

func (f *Frame) setField(id byte, value []byte) error {
	var err error
	switch id {
	case fID:
		f.ID = string(value)
	case fFrom:
		f.From, err = uuidString(value)
	case fTo:
		f.To, err = uuidString(value)
	case fConversationID:
		f.ConversationID = string(value)
	case fHeader:
		f.Header = string(value)
	case fCiphertext:
		f.Ciphertext = base64.StdEncoding.EncodeToString(value)
	case fStatus:
		f.Status = string(value)
	case fMessageID:
		f.MessageID = string(value)
	case fServerTS:
		if len(value) != 8 {
			return ErrBinaryFormat
		}
		f.ServerTS = int64(binary.BigEndian.Uint64(value))
	case fUserID:
		f.UserID, err = uuidString(value)
	case fOnline:
		if len(value) != 1 {
			return ErrBinaryFormat
		}
		online := value[0] == 1
		f.Online = &online
	case fLimit:
		if len(value) != 2 {
			return ErrBinaryFormat
		}
		f.Limit = binary.BigEndian.Uint16(value)
	case fIdentityKey:
		f.keys().IdentityKey = base64.StdEncoding.EncodeToString(value)
	case fSignedPrekey:
		f.keys().SignedPrekey = base64.StdEncoding.EncodeToString(value)
	case fSignedPrekeySig:
		f.keys().SignedPrekeySig = base64.StdEncoding.EncodeToString(value)
	case fOneTimePrekeys:
		k := f.keys()
		k.OneTimePrekeys = append(k.OneTimePrekeys, base64.StdEncoding.EncodeToString(value))
	case fOneTimePrekey:
		f.keys().OneTimePrekey = base64.StdEncoding.EncodeToString(value)
	case fErrCode:
		f.errorInfo().Code = string(value)
	case fErrMessage:
		f.errorInfo().Message = string(value)
	default:
		// Unknown fields are ignored for forward compatibility.
	}
	return err
}
