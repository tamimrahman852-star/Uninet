package protocol

import (
	"encoding/base64"
	"reflect"
	"testing"
)

func TestBinaryRoundTrip(t *testing.T) {
	online := true
	cipher := base64.StdEncoding.EncodeToString([]byte("opaque-ciphertext-bytes"))
	key := base64.StdEncoding.EncodeToString(make([]byte, 65))
	frames := []*Frame{
		{Type: TypePing},
		{
			Type:           TypeMessage,
			ID:             "msg_1",
			From:           "11111111-1111-4111-8111-111111111111",
			To:             "22222222-2222-4222-8222-222222222222",
			ConversationID: "conv-1",
			Header:         `{"v":1}`,
			Ciphertext:     cipher,
			ServerTS:       1_700_000_000_123,
		},
		{Type: TypePresence, MessageID: "p1", UserID: "22222222-2222-4222-8222-222222222222", Online: &online, ServerTS: 5},
		{Type: TypeHistoryFetch, ID: "h1", UserID: "22222222-2222-4222-8222-222222222222", Limit: 50, ServerTS: 42},
		{Type: TypeKeysBundle, MessageID: "k1", Keys: &KeyBundle{IdentityKey: key, SignedPrekey: key, SignedPrekeySig: key, OneTimePrekey: key}},
		{Type: TypeKeysPublish, ID: "k2", Keys: &KeyBundle{IdentityKey: key, SignedPrekey: key, SignedPrekeySig: key, OneTimePrekeys: []string{key, key}}},
		{Type: TypeError, MessageID: "m", Error: &FrameError{Code: "invalid_id", Message: "bad id"}},
	}
	for _, in := range frames {
		data, err := EncodeBinary(in)
		if err != nil {
			t.Fatalf("encode %s: %v", in.Type, err)
		}
		out, err := DecodeBinary(data)
		if err != nil {
			t.Fatalf("decode %s: %v", in.Type, err)
		}
		if !reflect.DeepEqual(in, out) {
			t.Fatalf("round trip mismatch for %s:\n in=%+v\nout=%+v", in.Type, in, out)
		}
	}
}

func TestBinaryRejectsCorruption(t *testing.T) {
	data, err := EncodeBinary(&Frame{Type: TypePing, ID: "x"})
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 0xFF
	if _, err := DecodeBinary(data); err == nil {
		t.Fatal("expected checksum failure")
	}
	if _, err := DecodeBinary([]byte{1, 2, 3}); err == nil {
		t.Fatal("expected short frame failure")
	}
}

func TestValidators(t *testing.T) {
	if !ValidID("abc-DEF_123") || ValidID("") || ValidID("a b") {
		t.Fatal("ValidID misbehaves")
	}
	if _, ok := NormalizeUserID("11111111-1111-4111-8111-111111111111"); !ok {
		t.Fatal("uuid should be valid")
	}
	if _, ok := NormalizeUserID("nope"); ok {
		t.Fatal("uuid should be invalid")
	}
	if !ValidBase64("aGVsbG8=", 32) || ValidBase64("!!!", 32) {
		t.Fatal("ValidBase64 misbehaves")
	}
}
