// Package storage persists encrypted message envelopes in Cassandra.
// The server only ever stores opaque ciphertext plus routing metadata.
package storage

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gocql/gocql"
	"github.com/uninet/chat-service/internal/protocol"
)

const maxHistoryBuckets = 24 // look back at most two years of monthly partitions

var keyspacePattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`)

// Config describes the Cassandra connection.
type Config struct {
	Hosts             []string
	Keyspace          string
	Username          string
	Password          string
	ReplicationFactor int
	ConnectTimeout    time.Duration
}

// Store wraps a Cassandra session.
type Store struct {
	session *gocql.Session
	log     *slog.Logger
}

// Open connects (retrying while the cluster boots), creates the keyspace and tables if needed.
func Open(ctx context.Context, cfg Config, log *slog.Logger) (*Store, error) {
	if len(cfg.Hosts) == 0 {
		return nil, errors.New("storage: no cassandra hosts configured")
	}
	if !keyspacePattern.MatchString(cfg.Keyspace) {
		return nil, fmt.Errorf("storage: invalid keyspace name %q", cfg.Keyspace)
	}
	if cfg.ReplicationFactor < 1 {
		cfg.ReplicationFactor = 1
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 90 * time.Second
	}

	newCluster := func(keyspace string) *gocql.ClusterConfig {
		c := gocql.NewCluster(cfg.Hosts...)
		c.Keyspace = keyspace
		c.Consistency = gocql.Quorum
		c.Timeout = 5 * time.Second
		c.ConnectTimeout = 10 * time.Second
		c.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(gocql.RoundRobinHostPolicy())
		if cfg.Username != "" {
			c.Authenticator = gocql.PasswordAuthenticator{Username: cfg.Username, Password: cfg.Password}
		}
		return c
	}

	deadline := time.Now().Add(cfg.ConnectTimeout)
	var bootstrap *gocql.Session
	for {
		var err error
		bootstrap, err = newCluster("").CreateSession()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("storage: cassandra unreachable: %w", err)
		}
		log.Warn("waiting for cassandra", "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}

	createKeyspace := fmt.Sprintf(
		`CREATE KEYSPACE IF NOT EXISTS %s WITH replication = {'class': 'SimpleStrategy', 'replication_factor': %d}`,
		cfg.Keyspace, cfg.ReplicationFactor)
	if err := bootstrap.Query(createKeyspace).WithContext(ctx).Exec(); err != nil {
		bootstrap.Close()
		return nil, fmt.Errorf("storage: create keyspace: %w", err)
	}
	bootstrap.Close()

	session, err := newCluster(cfg.Keyspace).CreateSession()
	if err != nil {
		return nil, fmt.Errorf("storage: connect to keyspace: %w", err)
	}

	const createTable = `
CREATE TABLE IF NOT EXISTS messages_by_pair (
	pair_key        text,
	bucket          int,
	ts              timestamp,
	msg_id          text,
	sender          text,
	recipient       text,
	conversation_id text,
	header          text,
	ciphertext      text,
	PRIMARY KEY ((pair_key, bucket), ts, msg_id)
) WITH CLUSTERING ORDER BY (ts DESC, msg_id DESC)`
	if err := session.Query(createTable).WithContext(ctx).Exec(); err != nil {
		session.Close()
		return nil, fmt.Errorf("storage: create table: %w", err)
	}
	return &Store{session: session, log: log}, nil
}

// Close releases the Cassandra session.
func (s *Store) Close() {
	if s != nil && s.session != nil {
		s.session.Close()
	}
}

// Ping runs a trivial query to verify connectivity.
func (s *Store) Ping(ctx context.Context) error {
	var now time.Time
	return s.session.Query(`SELECT toTimestamp(now()) FROM system.local`).WithContext(ctx).Scan(&now)
}

// PairKey returns the order-independent partition key of a two-party conversation.
func PairKey(a, b string) string {
	ids := []string{strings.ToLower(a), strings.ToLower(b)}
	sort.Strings(ids)
	return ids[0] + ":" + ids[1]
}

// BucketOf maps a time to its monthly partition bucket (YYYYMM).
func BucketOf(t time.Time) int {
	t = t.UTC()
	return t.Year()*100 + int(t.Month())
}

// SaveMessage persists a relayed message frame.
func (s *Store) SaveMessage(ctx context.Context, m *protocol.Frame) error {
	ts := time.UnixMilli(m.ServerTS).UTC()
	return s.session.Query(
		`INSERT INTO messages_by_pair (pair_key, bucket, ts, msg_id, sender, recipient, conversation_id, header, ciphertext)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		PairKey(m.From, m.To), BucketOf(ts), ts, m.ID, m.From, m.To, m.ConversationID, m.Header, m.Ciphertext,
	).WithContext(ctx).Exec()
}

// History returns up to limit messages exchanged between a and b strictly older than beforeMS (newest first).
func (s *Store) History(ctx context.Context, a, b string, beforeMS int64, limit int) ([]*protocol.Frame, error) {
	if limit <= 0 {
		return nil, nil
	}
	pair := PairKey(a, b)
	cursor := time.UnixMilli(beforeMS).UTC()
	bucketTime := cursor
	out := make([]*protocol.Frame, 0, limit)

	for i := 0; i < maxHistoryBuckets && len(out) < limit; i++ {
		iter := s.session.Query(
			`SELECT ts, msg_id, sender, recipient, conversation_id, header, ciphertext
			 FROM messages_by_pair WHERE pair_key = ? AND bucket = ? AND ts < ? LIMIT ?`,
			pair, BucketOf(bucketTime), cursor, limit-len(out),
		).WithContext(ctx).Iter()

		var (
			ts                                                  time.Time
			msgID, sender, recipient, conversationID, hdr, ciph string
		)
		for iter.Scan(&ts, &msgID, &sender, &recipient, &conversationID, &hdr, &ciph) {
			out = append(out, &protocol.Frame{
				Type:           protocol.TypeMessage,
				ID:             msgID,
				From:           sender,
				To:             recipient,
				ConversationID: conversationID,
				Header:         hdr,
				Ciphertext:     ciph,
				ServerTS:       ts.UnixMilli(),
				Status:         "history",
			})
		}
		if err := iter.Close(); err != nil {
			return nil, err
		}
		// Step to the last millisecond of the previous month.
		firstOfMonth := time.Date(bucketTime.Year(), bucketTime.Month(), 1, 0, 0, 0, 0, time.UTC)
		bucketTime = firstOfMonth.Add(-time.Millisecond)
	}
	return out, nil
}
