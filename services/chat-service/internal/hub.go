// Package internal contains the connection hub: client lifecycle, Redis backplane fan-out,
// offline queue, presence and public-key bundles. Message semantics live in internal/handler.
//
// Scaling model
//   - Every instance subscribes to a Redis channel per locally connected user (chat:user:<id>).
//     Delivering to a user is a PUBLISH; if nobody is subscribed the opaque frame goes to a capped,
//     expiring offline queue (chat:offline:<id>) and is flushed on the next connect.
//   - Presence is a Redis sorted set of device ids scored by expiry time.
package internal

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"github.com/uninet/chat-service/internal/protocol"
	"golang.org/x/time/rate"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 30 * time.Second // must be < pongWait
	sendBuffer = 256

	// MaxDevicesPerUser caps concurrent connections of one user on this instance.
	MaxDevicesPerUser = 10
	// MaxOneTimePrekeys is the maximum number of one-time prekeys accepted per publish.
	MaxOneTimePrekeys = 100
	// MaxKeyFieldChars bounds each base64 key field.
	MaxKeyFieldChars = 512

	maxOneTimePrekeyPool = 500
	opTimeout            = 3 * time.Second
)

// ErrKeysNotFound is returned when a user has not published a key bundle.
var ErrKeysNotFound = errors.New("key bundle not found")

// Config holds runtime settings shared by the hub and HTTP handlers.
type Config struct {
	Port            string
	RedisURL        string
	JWTSecret       []byte
	AllowedOrigins  map[string]struct{}
	AllowAllOrigins bool
	MaxFrameBytes   int64
	OfflineTTL      time.Duration
	OfflineQueueMax int64
}

// FrameHandler processes a validated, rate-limited frame from a client.
type FrameHandler interface {
	Handle(c *Client, f *protocol.Frame)
}

func userChannel(id string) string { return "chat:user:" + id }
func offlineKey(id string) string  { return "chat:offline:" + id }
func presenceKey(id string) string { return "chat:presence:" + id }
func keysKey(id string) string     { return "chat:keys:" + id }
func otpkKey(id string) string     { return "chat:otpk:" + id }

/* ------------------------------------------------------------------ */
/* Hub                                                                 */
/* ------------------------------------------------------------------ */

// Hub tracks local connections and bridges them through Redis.
type Hub struct {
	cfg     *Config
	rdb     *redis.Client
	log     *slog.Logger
	baseCtx context.Context
	handler FrameHandler

	mu    sync.RWMutex
	users map[string]map[*Client]struct{}
	subs  map[string]*redis.PubSub
}

// NewHub creates a hub. SetHandler must be called before clients connect.
func NewHub(ctx context.Context, cfg *Config, rdb *redis.Client, log *slog.Logger) *Hub {
	return &Hub{
		cfg:     cfg,
		rdb:     rdb,
		log:     log,
		baseCtx: ctx,
		users:   make(map[string]map[*Client]struct{}),
		subs:    make(map[string]*redis.PubSub),
	}
}

// SetHandler installs the frame handler.
func (h *Hub) SetHandler(handler FrameHandler) { h.handler = handler }

// Config returns the hub configuration.
func (h *Hub) Config() *Config { return h.cfg }

// OpCtx returns a short-lived context for a single Redis/DB operation.
func (h *Hub) OpCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(h.baseCtx, opTimeout)
}

// ConnectionCount returns the number of local connections of a user.
func (h *Hub) ConnectionCount(userID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.users[userID])
}

// Register adds a client and subscribes to its user channel when it is the first local connection.
func (h *Hub) Register(c *Client) error {
	h.mu.Lock()
	set, exists := h.users[c.UserID]
	if !exists {
		set = make(map[*Client]struct{})
		h.users[c.UserID] = set
	}
	set[c] = struct{}{}
	h.mu.Unlock()

	if !exists {
		if err := h.subscribe(c.UserID); err != nil {
			h.Unregister(c)
			return err
		}
	}
	h.touchPresence(c)
	return nil
}

func (h *Hub) subscribe(userID string) error {
	ctx, cancel := context.WithTimeout(h.baseCtx, opTimeout)
	defer cancel()

	ps := h.rdb.Subscribe(ctx, userChannel(userID))
	// Block until Redis confirms the subscription so no published frame is missed.
	if _, err := ps.Receive(ctx); err != nil {
		_ = ps.Close()
		return err
	}

	h.mu.Lock()
	if _, active := h.users[userID]; !active {
		h.mu.Unlock() // every client disconnected while we were subscribing
		_ = ps.Close()
		return nil
	}
	h.subs[userID] = ps
	h.mu.Unlock()

	go func() {
		for msg := range ps.Channel() {
			h.deliverLocal(userID, msg.Payload)
		}
	}()
	return nil
}

// Unregister removes a client and tears down the user subscription when it was the last one.
func (h *Hub) Unregister(c *Client) {
	var ps *redis.PubSub
	h.mu.Lock()
	if set, ok := h.users[c.UserID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.users, c.UserID)
			ps = h.subs[c.UserID]
			delete(h.subs, c.UserID)
		}
	}
	h.mu.Unlock()

	if ps != nil {
		_ = ps.Close()
	}

	ctx, cancel := h.OpCtx()
	defer cancel()
	if err := h.rdb.ZRem(ctx, presenceKey(c.UserID), c.DeviceID).Err(); err != nil {
		h.log.Warn("presence cleanup failed", "user_id", c.UserID, "err", err)
	}
}

// deliverLocal fans a published frame out to every locally connected device of the user.
func (h *Hub) deliverLocal(userID string, payload string) {
	var f protocol.Frame
	if err := json.Unmarshal([]byte(payload), &f); err != nil {
		h.log.Warn("dropping malformed backplane payload", "err", err)
		return
	}

	h.mu.RLock()
	set := h.users[userID]
	targets := make([]*Client, 0, len(set))
	for c := range set {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		if !c.enqueue(&f) {
			h.log.Warn("slow consumer, disconnecting", "user_id", c.UserID, "device_id", c.DeviceID)
			go c.Shutdown(websocket.ClosePolicyViolation, "slow consumer")
		}
	}
}

// Route publishes a frame to the recipient. It reports whether a live subscriber received it;
// otherwise, when queueIfOffline is set, the frame is stored in the capped offline queue.
func (h *Hub) Route(ctx context.Context, to string, f *protocol.Frame, queueIfOffline bool) (bool, error) {
	payload, err := json.Marshal(f)
	if err != nil {
		return false, err
	}
	receivers, err := h.rdb.Publish(ctx, userChannel(to), payload).Result()
	if err != nil {
		return false, err
	}
	if receivers > 0 {
		return true, nil
	}
	if !queueIfOffline {
		return false, nil
	}
	key := offlineKey(to)
	pipe := h.rdb.TxPipeline()
	pipe.RPush(ctx, key, payload)
	pipe.LTrim(ctx, key, -h.cfg.OfflineQueueMax, -1)
	pipe.Expire(ctx, key, h.cfg.OfflineTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return false, err
	}
	return false, nil
}

// flushOffline drains the user's offline queue into the freshly connected client.
func (h *Hub) flushOffline(c *Client) {
	key := offlineKey(c.UserID)
	for {
		select {
		case <-c.done:
			return
		default:
		}
		ctx, cancel := h.OpCtx()
		raw, err := h.rdb.LPop(ctx, key).Bytes()
		cancel()
		if errors.Is(err, redis.Nil) {
			return
		}
		if err != nil {
			h.log.Warn("offline flush failed", "user_id", c.UserID, "err", err)
			return
		}
		var f protocol.Frame
		if err := json.Unmarshal(raw, &f); err != nil {
			h.log.Warn("dropping malformed offline frame", "user_id", c.UserID, "err", err)
			continue
		}
		select {
		case c.send <- &f:
		case <-c.done:
			// Put the frame back at the head so the next connection receives it.
			rctx, rcancel := h.OpCtx()
			if perr := h.rdb.LPush(rctx, key, raw).Err(); perr != nil {
				h.log.Warn("could not requeue offline frame", "user_id", c.UserID, "err", perr)
			}
			rcancel()
			return
		}
	}
}

func (h *Hub) touchPresence(c *Client) {
	ctx, cancel := h.OpCtx()
	defer cancel()
	key := presenceKey(c.UserID)
	expiry := time.Now().Add(2 * pongWait).Unix()
	pipe := h.rdb.Pipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(expiry), Member: c.DeviceID})
	pipe.Expire(ctx, key, 3*pongWait)
	if _, err := pipe.Exec(ctx); err != nil {
		h.log.Warn("presence update failed", "user_id", c.UserID, "err", err)
	}
}

// IsOnline reports whether any device of the user has a live connection on any instance.
func (h *Hub) IsOnline(ctx context.Context, userID string) (bool, error) {
	key := presenceKey(userID)
	pipe := h.rdb.Pipeline()
	pipe.ZRemRangeByScore(ctx, key, "-inf", strconv.FormatInt(time.Now().Unix(), 10))
	card := pipe.ZCard(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil {
		return false, err
	}
	return card.Val() > 0, nil
}

// StoreKeys saves a user's public key bundle and appends one-time prekeys.
func (h *Hub) StoreKeys(ctx context.Context, userID string, kb *protocol.KeyBundle) error {
	pipe := h.rdb.TxPipeline()
	pipe.HSet(ctx, keysKey(userID), map[string]interface{}{
		"identity_key":            kb.IdentityKey,
		"signed_prekey":           kb.SignedPrekey,
		"signed_prekey_signature": kb.SignedPrekeySig,
		"updated_at":              time.Now().Unix(),
	})
	if len(kb.OneTimePrekeys) > 0 {
		values := make([]interface{}, len(kb.OneTimePrekeys))
		for i, v := range kb.OneTimePrekeys {
			values[i] = v
		}
		pipe.RPush(ctx, otpkKey(userID), values...)
		pipe.LTrim(ctx, otpkKey(userID), -maxOneTimePrekeyPool, -1)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// FetchBundle returns the public bundle and atomically consumes one one-time prekey (if any remain).
func (h *Hub) FetchBundle(ctx context.Context, userID string) (*protocol.KeyBundle, error) {
	fields, err := h.rdb.HGetAll(ctx, keysKey(userID)).Result()
	if err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, ErrKeysNotFound
	}
	kb := &protocol.KeyBundle{
		IdentityKey:     fields["identity_key"],
		SignedPrekey:    fields["signed_prekey"],
		SignedPrekeySig: fields["signed_prekey_signature"],
	}
	otpk, err := h.rdb.LPop(ctx, otpkKey(userID)).Result()
	if err == nil {
		kb.OneTimePrekey = otpk
	} else if !errors.Is(err, redis.Nil) {
		return nil, err
	}
	return kb, nil
}

// CloseAll sends a close frame to every local client (used on shutdown).
func (h *Hub) CloseAll(code int, reason string) {
	h.mu.RLock()
	all := make([]*Client, 0)
	for _, set := range h.users {
		for c := range set {
			all = append(all, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range all {
		c.Shutdown(code, reason)
	}
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

// Client is one authenticated WebSocket connection (one device).
type Client struct {
	UserID   string
	DeviceID string
	Log      *slog.Logger

	hub       *Hub
	conn      *websocket.Conn
	binary    bool
	expiresAt time.Time

	send       chan *protocol.Frame
	done       chan struct{}
	closeOnce  sync.Once
	msgLimiter *rate.Limiter
	keyLimiter *rate.Limiter
}

// NewClient wraps an upgraded connection. binary selects the MTProto-style binary transport.
func NewClient(h *Hub, conn *websocket.Conn, userID, deviceID string, expiresAt time.Time, binary bool) *Client {
	return &Client{
		UserID:     userID,
		DeviceID:   deviceID,
		Log:        h.log.With("user_id", userID, "device_id", deviceID),
		hub:        h,
		conn:       conn,
		binary:     binary,
		expiresAt:  expiresAt,
		send:       make(chan *protocol.Frame, sendBuffer),
		done:       make(chan struct{}),
		msgLimiter: rate.NewLimiter(rate.Limit(20), 40),
		keyLimiter: rate.NewLimiter(rate.Every(time.Second), 5),
	}
}

// AllowKeyOp rate limits key publish/fetch operations.
func (c *Client) AllowKeyOp() bool { return c.keyLimiter.Allow() }

func (c *Client) enqueue(f *protocol.Frame) bool {
	select {
	case <-c.done:
		return true // connection is going away; dropping is not a slow-consumer problem
	default:
	}
	select {
	case c.send <- f:
		return true
	default:
		return false
	}
}

// Send queues a frame for delivery to this client.
func (c *Client) Send(f *protocol.Frame) {
	if !c.enqueue(f) {
		go c.Shutdown(websocket.ClosePolicyViolation, "slow consumer")
	}
}

// SendError queues an error frame referencing a client message id.
func (c *Client) SendError(refID, code, message string) {
	c.Send(&protocol.Frame{Type: protocol.TypeError, MessageID: refID, Error: &protocol.FrameError{Code: code, Message: message}})
}

func (c *Client) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *Client) writeClose(code int, reason string) {
	_ = c.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(time.Second),
	)
}

// Shutdown sends a WebSocket close frame and tears the connection down.
func (c *Client) Shutdown(code int, reason string) {
	c.writeClose(code, reason)
	c.close()
}

// Run blocks until the connection ends. The hub registration must already be done.
func (c *Client) Run() {
	go c.writePump()
	go c.hub.flushOffline(c)
	c.readPump()
	c.hub.Unregister(c)
	c.close()
}

func (c *Client) readPump() {
	c.conn.SetReadLimit(c.hub.cfg.MaxFrameBytes)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		c.hub.touchPresence(c)
		return nil
	})

	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived) {
				c.Log.Debug("connection closed unexpectedly", "err", err)
			}
			return
		}
		// Any inbound traffic proves liveness.
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))

		if !c.msgLimiter.Allow() {
			c.SendError("", "rate_limited", "too many frames, slow down")
			continue
		}

		var f *protocol.Frame
		switch messageType {
		case websocket.TextMessage:
			f = &protocol.Frame{}
			if err := json.Unmarshal(data, f); err != nil {
				c.SendError("", "invalid_json", "frame is not valid JSON")
				continue
			}
		case websocket.BinaryMessage:
			f, err = protocol.DecodeBinary(data)
			if err != nil {
				c.SendError("", "invalid_binary", "binary frame is malformed")
				continue
			}
		default:
			continue
		}
		c.hub.handler.Handle(c, f)
	}
}

func (c *Client) encode(f *protocol.Frame) (int, []byte, error) {
	if c.binary {
		b, err := protocol.EncodeBinary(f)
		return websocket.BinaryMessage, b, err
	}
	b, err := json.Marshal(f)
	return websocket.TextMessage, b, err
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer c.close()

	for {
		select {
		case f := <-c.send:
			messageType, payload, err := c.encode(f)
			if err != nil {
				c.Log.Warn("dropping unencodable frame", "type", f.Type, "err", err)
				continue
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(messageType, payload); err != nil {
				return
			}
		case <-ticker.C:
			if time.Now().After(c.expiresAt) {
				c.writeClose(websocket.ClosePolicyViolation, "access token expired")
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}
