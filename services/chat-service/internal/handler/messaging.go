package handler

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/uninet/chat-service/internal"
	"github.com/uninet/chat-service/internal/protocol"
	"github.com/uninet/chat-service/internal/storage"
)

const (
	maxHeaderChars  = 4096
	defaultHistory  = 50
	maxHistoryLimit = 100
)

// Messaging implements internal.FrameHandler: validation and routing of every client frame.
type Messaging struct {
	hub   *internal.Hub
	store *storage.Store // nil when Cassandra is not configured (history disabled)
	log   *slog.Logger
}

// NewMessaging builds the frame handler. store may be nil.
func NewMessaging(hub *internal.Hub, store *storage.Store, log *slog.Logger) *Messaging {
	return &Messaging{hub: hub, store: store, log: log}
}

// Handle dispatches a frame by type.
func (m *Messaging) Handle(c *internal.Client, f *protocol.Frame) {
	switch f.Type {
	case protocol.TypePing:
		c.Send(&protocol.Frame{Type: protocol.TypePong, ServerTS: time.Now().UnixMilli()})
	case protocol.TypeMessage:
		m.handleMessage(c, f)
	case protocol.TypeTyping:
		m.handleTyping(c, f)
	case protocol.TypeReceipt:
		m.handleReceipt(c, f)
	case protocol.TypeKeysPublish:
		m.handleKeysPublish(c, f)
	case protocol.TypeKeysFetch:
		m.handleKeysFetch(c, f)
	case protocol.TypePresenceQuery:
		m.handlePresenceQuery(c, f)
	case protocol.TypeHistoryFetch:
		m.handleHistoryFetch(c, f)
	default:
		c.SendError(f.ID, "unknown_type", "unsupported frame type")
	}
}

func (m *Messaging) opCtx() (context.Context, context.CancelFunc) { return m.hub.OpCtx() }

func (m *Messaging) handleMessage(c *internal.Client, f *protocol.Frame) {
	if !protocol.ValidID(f.ID) {
		c.SendError(f.ID, "invalid_id", "id must be 1-64 characters of [A-Za-z0-9_-]")
		return
	}
	to, ok := protocol.NormalizeUserID(f.To)
	if !ok {
		c.SendError(f.ID, "invalid_recipient", "to must be a user uuid")
		return
	}
	if !protocol.ValidBase64(f.Ciphertext, int(m.hub.Config().MaxFrameBytes)) {
		c.SendError(f.ID, "invalid_ciphertext", "ciphertext must be non-empty standard base64")
		return
	}
	if len(f.Header) > maxHeaderChars {
		c.SendError(f.ID, "header_too_large", "header exceeds the size limit")
		return
	}
	if len(f.ConversationID) > 64 {
		c.SendError(f.ID, "invalid_conversation", "conversation_id is too long")
		return
	}

	now := time.Now().UnixMilli()
	out := &protocol.Frame{
		Type:           protocol.TypeMessage,
		ID:             f.ID,
		From:           c.UserID,
		To:             to,
		ConversationID: f.ConversationID,
		Header:         f.Header,
		Ciphertext:     f.Ciphertext,
		ServerTS:       now,
	}

	ctx, cancel := m.opCtx()
	defer cancel()

	if m.store != nil {
		if err := m.store.SaveMessage(ctx, out); err != nil {
			c.Log.Error("persisting message failed", "err", err)
			c.SendError(f.ID, "unavailable", "message could not be stored, retry")
			return
		}
	}

	delivered, err := m.hub.Route(ctx, to, out, true)
	if err != nil {
		c.Log.Error("message relay failed", "err", err)
		c.SendError(f.ID, "unavailable", "message could not be relayed, retry")
		return
	}
	status := "queued"
	if delivered {
		status = "relayed"
	}
	c.Send(&protocol.Frame{Type: protocol.TypeAck, MessageID: f.ID, Status: status, ServerTS: now})
}

func (m *Messaging) handleTyping(c *internal.Client, f *protocol.Frame) {
	to, ok := protocol.NormalizeUserID(f.To)
	if !ok {
		c.SendError(f.ID, "invalid_recipient", "to must be a user uuid")
		return
	}
	if f.Status != "start" && f.Status != "stop" {
		c.SendError(f.ID, "invalid_status", "status must be start or stop")
		return
	}
	if len(f.ConversationID) > 64 {
		c.SendError(f.ID, "invalid_conversation", "conversation_id is too long")
		return
	}
	ctx, cancel := m.opCtx()
	defer cancel()
	out := &protocol.Frame{Type: protocol.TypeTyping, From: c.UserID, To: to, ConversationID: f.ConversationID, Status: f.Status, ServerTS: time.Now().UnixMilli()}
	if _, err := m.hub.Route(ctx, to, out, false); err != nil {
		c.Log.Warn("typing relay failed", "err", err)
	}
}

func (m *Messaging) handleReceipt(c *internal.Client, f *protocol.Frame) {
	to, ok := protocol.NormalizeUserID(f.To)
	if !ok {
		c.SendError(f.ID, "invalid_recipient", "to must be a user uuid")
		return
	}
	if !protocol.ValidID(f.MessageID) {
		c.SendError(f.ID, "invalid_message_id", "message_id is required")
		return
	}
	if f.Status != "delivered" && f.Status != "read" {
		c.SendError(f.MessageID, "invalid_status", "status must be delivered or read")
		return
	}
	ctx, cancel := m.opCtx()
	defer cancel()
	out := &protocol.Frame{Type: protocol.TypeReceipt, From: c.UserID, To: to, MessageID: f.MessageID, ConversationID: f.ConversationID, Status: f.Status, ServerTS: time.Now().UnixMilli()}
	if _, err := m.hub.Route(ctx, to, out, true); err != nil {
		c.Log.Warn("receipt relay failed", "err", err)
		c.SendError(f.MessageID, "unavailable", "receipt could not be relayed")
	}
}

func (m *Messaging) handleKeysPublish(c *internal.Client, f *protocol.Frame) {
	if !c.AllowKeyOp() {
		c.SendError(f.ID, "rate_limited", "too many key operations")
		return
	}
	kb := f.Keys
	if kb == nil ||
		!protocol.ValidBase64(kb.IdentityKey, internal.MaxKeyFieldChars) ||
		!protocol.ValidBase64(kb.SignedPrekey, internal.MaxKeyFieldChars) ||
		!protocol.ValidBase64(kb.SignedPrekeySig, internal.MaxKeyFieldChars) {
		c.SendError(f.ID, "invalid_keys", "identity_key, signed_prekey and signed_prekey_signature must be base64")
		return
	}
	if len(kb.OneTimePrekeys) > internal.MaxOneTimePrekeys {
		c.SendError(f.ID, "too_many_prekeys", "at most 100 one-time prekeys per publish")
		return
	}
	for _, k := range kb.OneTimePrekeys {
		if !protocol.ValidBase64(k, internal.MaxKeyFieldChars) {
			c.SendError(f.ID, "invalid_keys", "one_time_prekeys must be base64")
			return
		}
	}
	ctx, cancel := m.opCtx()
	defer cancel()
	if err := m.hub.StoreKeys(ctx, c.UserID, kb); err != nil {
		c.Log.Error("storing keys failed", "err", err)
		c.SendError(f.ID, "unavailable", "keys could not be stored, retry")
		return
	}
	c.Send(&protocol.Frame{Type: protocol.TypeAck, MessageID: f.ID, Status: "stored", ServerTS: time.Now().UnixMilli()})
}

func (m *Messaging) handleKeysFetch(c *internal.Client, f *protocol.Frame) {
	if !c.AllowKeyOp() {
		c.SendError(f.ID, "rate_limited", "too many key operations")
		return
	}
	target, ok := protocol.NormalizeUserID(f.UserID)
	if !ok {
		c.SendError(f.ID, "invalid_user", "user_id must be a uuid")
		return
	}
	ctx, cancel := m.opCtx()
	defer cancel()
	kb, err := m.hub.FetchBundle(ctx, target)
	if errors.Is(err, internal.ErrKeysNotFound) {
		c.SendError(f.ID, "keys_not_found", "user has not published keys")
		return
	}
	if err != nil {
		c.Log.Error("fetching keys failed", "err", err)
		c.SendError(f.ID, "unavailable", "keys could not be fetched, retry")
		return
	}
	c.Send(&protocol.Frame{Type: protocol.TypeKeysBundle, MessageID: f.ID, UserID: target, Keys: kb, ServerTS: time.Now().UnixMilli()})
}

func (m *Messaging) handlePresenceQuery(c *internal.Client, f *protocol.Frame) {
	target, ok := protocol.NormalizeUserID(f.UserID)
	if !ok {
		c.SendError(f.ID, "invalid_user", "user_id must be a uuid")
		return
	}
	ctx, cancel := m.opCtx()
	defer cancel()
	online, err := m.hub.IsOnline(ctx, target)
	if err != nil {
		c.SendError(f.ID, "unavailable", "presence could not be queried")
		return
	}
	c.Send(&protocol.Frame{Type: protocol.TypePresence, MessageID: f.ID, UserID: target, Online: &online, ServerTS: time.Now().UnixMilli()})
}

// handleHistoryFetch replays stored ciphertext between the caller and a peer.
// Each message is sent as a "message" frame with status "history", followed by an ack with
// status "history_end" whose server_ts is the cursor (oldest timestamp) for the next page.
func (m *Messaging) handleHistoryFetch(c *internal.Client, f *protocol.Frame) {
	if m.store == nil {
		c.SendError(f.ID, "history_disabled", "message history is not enabled on this server")
		return
	}
	peer, ok := protocol.NormalizeUserID(f.UserID)
	if !ok {
		c.SendError(f.ID, "invalid_user", "user_id must be a uuid")
		return
	}
	limit := int(f.Limit)
	if limit <= 0 {
		limit = defaultHistory
	}
	if limit > maxHistoryLimit {
		limit = maxHistoryLimit
	}
	before := f.ServerTS
	if before <= 0 {
		before = time.Now().UnixMilli() + 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	messages, err := m.store.History(ctx, c.UserID, peer, before, limit)
	if err != nil {
		c.Log.Error("history query failed", "err", err)
		c.SendError(f.ID, "unavailable", "history could not be loaded")
		return
	}
	var oldest int64
	for _, msg := range messages {
		c.Send(msg)
		oldest = msg.ServerTS
	}
	c.Send(&protocol.Frame{Type: protocol.TypeAck, MessageID: f.ID, Status: "history_end", ServerTS: oldest})
}
