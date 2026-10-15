enum MessageStatus { sending, queued, sent, delivered, read, failed, received }

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.peerId,
    required this.mine,
    required this.text,
    required this.ts,
    required this.status,
    this.verified,
  });

  final String id;
  final String peerId;
  final bool mine;
  final String text;
  final int ts;
  final MessageStatus status;
  final bool? verified;

  ChatMessage copyWith({MessageStatus? status, String? text}) => ChatMessage(
        id: id,
        peerId: peerId,
        mine: mine,
        text: text ?? this.text,
        ts: ts,
        status: status ?? this.status,
        verified: verified,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'peerId': peerId,
        'mine': mine,
        'text': text,
        'ts': ts,
        'status': status.name,
        'verified': verified,
      };

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        id: json['id'] as String,
        peerId: json['peerId'] as String,
        mine: json['mine'] as bool,
        text: json['text'] as String,
        ts: json['ts'] as int,
        status: MessageStatus.values.firstWhere((s) => s.name == json['status'], orElse: () => MessageStatus.sent),
        verified: json['verified'] as bool?,
      );
}

class ChatPeer {
  const ChatPeer({
    required this.id,
    this.username,
    this.fullName,
    this.avatarUrl,
    this.lastTs = 0,
    this.unread = 0,
    this.online = false,
    this.typing = false,
  });

  final String id;
  final String? username;
  final String? fullName;
  final String? avatarUrl;
  final int lastTs;
  final int unread;
  final bool online;
  final bool typing;

  String get displayName {
    if (fullName != null && fullName!.isNotEmpty) return fullName!;
    if (username != null && username!.isNotEmpty) return '@$username';
    return 'User ${id.substring(0, 6)}';
  }

  ChatPeer copyWith({
    String? username,
    String? fullName,
    String? avatarUrl,
    int? lastTs,
    int? unread,
    bool? online,
    bool? typing,
  }) =>
      ChatPeer(
        id: id,
        username: username ?? this.username,
        fullName: fullName ?? this.fullName,
        avatarUrl: avatarUrl ?? this.avatarUrl,
        lastTs: lastTs ?? this.lastTs,
        unread: unread ?? this.unread,
        online: online ?? this.online,
        typing: typing ?? this.typing,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'username': username,
        'fullName': fullName,
        'avatarUrl': avatarUrl,
        'lastTs': lastTs,
        'unread': unread,
      };

  factory ChatPeer.fromJson(Map<String, dynamic> json) => ChatPeer(
        id: json['id'] as String,
        username: json['username'] as String?,
        fullName: json['fullName'] as String?,
        avatarUrl: json['avatarUrl'] as String?,
        lastTs: (json['lastTs'] as num?)?.toInt() ?? 0,
        unread: (json['unread'] as num?)?.toInt() ?? 0,
      );
}

/// Events pushed from the repository to the cubit.
sealed class ChatEvent {
  const ChatEvent();
}

class IncomingMessageEvent extends ChatEvent {
  const IncomingMessageEvent(this.message);
  final ChatMessage message;
}

class ReceiptEvent extends ChatEvent {
  const ReceiptEvent({required this.peerId, required this.messageId, required this.status});
  final String peerId;
  final String messageId;
  final MessageStatus status;
}

class TypingEvent extends ChatEvent {
  const TypingEvent({required this.peerId, required this.typing});
  final String peerId;
  final bool typing;
}

class ConnectionEvent extends ChatEvent {
  const ConnectionEvent(this.open);
  final bool open;
}
