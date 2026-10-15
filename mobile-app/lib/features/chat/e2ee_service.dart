import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// End-to-end encryption, wire-compatible with frontend-web/src/utils/e2ee.ts:
///  - identity key: ECDSA P-256 (signs)         - signed prekey: ECDH P-256, signed by the identity key
///  - encrypt: verify the recipient's prekey signature, ephemeral ECDH -> HKDF-SHA256 -> AES-256-GCM
///    (AAD "<sender>><recipient>"), sign (ephemeral public key || ciphertext) with the identity key
///  - public keys are raw uncompressed points (0x04 || X || Y), signatures are raw r||s (64 bytes)
/// Private keys live in the platform keystore. As on web, there is no Double Ratchet (no forward secrecy
/// beyond signed-prekey rotation); use libsignal for that.
class PeerBundle {
  const PeerBundle({required this.identityKey, required this.signedPrekey, required this.signedPrekeySignature});

  final String identityKey;
  final String signedPrekey;
  final String signedPrekeySignature;
}

class EncryptedPayload {
  const EncryptedPayload({required this.header, required this.ciphertext});

  final String header;
  final String ciphertext;
}

class DecryptResult {
  const DecryptResult({required this.text, required this.verified});

  final String text;

  /// true: valid signature, false: invalid, null: sender keys were unavailable.
  final bool? verified;
}

class E2eeService {
  E2eeService({FlutterSecureStorage? storage}) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  final Ecdsa _ecdsa = Ecdsa.p256(Sha256());
  final Ecdh _ecdh = Ecdh.p256(length: 32);
  final AesGcm _aes = AesGcm.with256bits();
  final Hkdf _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);

  EcKeyPairData? _identity;
  EcKeyPairData? _signedPrekey;
  late String identityPublic;
  late String signedPrekeyPublic;
  late String signedPrekeySignature;
  bool _signaturesAreDer = false;

  PeerBundle get publicBundle => PeerBundle(
        identityKey: identityPublic,
        signedPrekey: signedPrekeyPublic,
        signedPrekeySignature: signedPrekeySignature,
      );

  /* ------------------------------ setup ------------------------------ */

  Future<void> init(String userId) async {
    await _detectSignatureFormat();
    final storageKey = 'uninet.e2ee.$userId';
    final raw = await _storage.read(key: storageKey);
    if (raw != null) {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      _identity = _restorePair(data['identity'] as Map<String, dynamic>);
      _signedPrekey = _restorePair(data['spk'] as Map<String, dynamic>);
      identityPublic = data['identityPub'] as String;
      signedPrekeyPublic = data['spkPub'] as String;
      signedPrekeySignature = data['spkSig'] as String;
      return;
    }

    final identityPair = await _ecdsa.newKeyPair();
    final prekeyPair = await _ecdh.newKeyPair();
    final identity = await identityPair.extract();
    final prekey = await prekeyPair.extract();
    _identity = identity;
    _signedPrekey = prekey;

    identityPublic = base64Encode(_rawPublic(identity));
    final prekeyRaw = _rawPublic(prekey);
    signedPrekeyPublic = base64Encode(prekeyRaw);
    signedPrekeySignature = base64Encode(await _sign(identity, prekeyRaw));

    await _storage.write(
      key: storageKey,
      value: jsonEncode(<String, dynamic>{
        'identity': _serializePair(identity),
        'spk': _serializePair(prekey),
        'identityPub': identityPublic,
        'spkPub': signedPrekeyPublic,
        'spkSig': signedPrekeySignature,
      }),
    );
  }

  Map<String, String> _serializePair(EcKeyPairData data) => <String, String>{
        'd': base64Encode(data.d),
        'x': base64Encode(data.x),
        'y': base64Encode(data.y),
      };

  EcKeyPairData _restorePair(Map<String, dynamic> json) => EcKeyPairData(
        d: base64Decode(json['d'] as String),
        x: base64Decode(json['x'] as String),
        y: base64Decode(json['y'] as String),
        type: KeyPairType.p256,
      );

  /// Some platforms return DER-encoded ECDSA signatures; the wire format is always raw r||s.
  Future<void> _detectSignatureFormat() async {
    final probeKey = await _ecdsa.newKeyPair();
    final signature = await _ecdsa.sign(<int>[1, 2, 3], keyPair: probeKey);
    _signaturesAreDer = signature.bytes.length != 64;
  }

  /* ------------------------------ helpers ------------------------------ */

  Uint8List _pad32(List<int> value) {
    if (value.length == 32) return Uint8List.fromList(value);
    if (value.length > 32) return Uint8List.fromList(value.sublist(value.length - 32));
    return Uint8List.fromList(<int>[...List<int>.filled(32 - value.length, 0), ...value]);
  }

  Uint8List _rawPublic(EcKeyPairData data) => Uint8List.fromList(<int>[0x04, ..._pad32(data.x), ..._pad32(data.y)]);

  EcPublicKey _publicFromRaw(Uint8List raw) {
    if (raw.length != 65 || raw[0] != 0x04) throw const FormatException('Invalid P-256 public key');
    return EcPublicKey(x: raw.sublist(1, 33), y: raw.sublist(33, 65), type: KeyPairType.p256);
  }

  Future<List<int>> _sign(EcKeyPairData pair, List<int> data) async {
    final signature = await _ecdsa.sign(data, keyPair: pair);
    final bytes = signature.bytes;
    return _signaturesAreDer ? _derToRaw(bytes) : bytes;
  }

  Future<bool> _verify(Uint8List identityRaw, List<int> data, List<int> rawSignature) async {
    final publicKey = _publicFromRaw(identityRaw);
    final bytes = _signaturesAreDer ? _rawToDer(rawSignature) : rawSignature;
    return _ecdsa.verify(data, signature: Signature(bytes, publicKey: publicKey));
  }

  List<int> _derToRaw(List<int> der) {
    var offset = 2;
    if (der[1] & 0x80 != 0) offset += der[1] & 0x7f;
    List<int> readInt() {
      final length = der[offset + 1];
      var value = der.sublist(offset + 2, offset + 2 + length);
      offset += 2 + length;
      while (value.length > 32 && value.first == 0) {
        value = value.sublist(1);
      }
      return _pad32(value);
    }

    final r = readInt();
    final s = readInt();
    return <int>[...r, ...s];
  }

  List<int> _rawToDer(List<int> raw) {
    List<int> encode(List<int> part) {
      var value = part.toList();
      while (value.length > 1 && value.first == 0) {
        value = value.sublist(1);
      }
      if (value.first & 0x80 != 0) value = <int>[0, ...value];
      return <int>[0x02, value.length, ...value];
    }

    final body = <int>[...encode(raw.sublist(0, 32)), ...encode(raw.sublist(32, 64))];
    return <int>[0x30, body.length, ...body];
  }

  Future<SecretKey> _deriveAesKey(SecretKey shared) {
    return _hkdf.deriveKey(secretKey: shared, nonce: List<int>.filled(32, 0), info: utf8.encode('uninet-e2ee-v1'));
  }

  Uint8List _randomBytes(int length) {
    final random = Random.secure();
    return Uint8List.fromList(List<int>.generate(length, (_) => random.nextInt(256)));
  }

  /* ------------------------------ public API ------------------------------ */

  Future<bool> verifyBundle(PeerBundle bundle) async {
    try {
      return await _verify(base64Decode(bundle.identityKey), base64Decode(bundle.signedPrekey), base64Decode(bundle.signedPrekeySignature));
    } on Object {
      return false;
    }
  }

  Future<EncryptedPayload> encryptFor({
    required String myId,
    required String peerId,
    required PeerBundle bundle,
    required String plaintext,
  }) async {
    final identity = _identity;
    if (identity == null) throw StateError('E2EE not initialised');
    if (!await verifyBundle(bundle)) throw StateError("The recipient's key bundle failed verification");

    final ephemeralPair = await _ecdh.newKeyPair();
    final ephemeral = await ephemeralPair.extract();
    final epkRaw = _rawPublic(ephemeral);
    final shared = await _ecdh.sharedSecretKey(keyPair: ephemeralPair, remotePublicKey: _publicFromRaw(base64Decode(bundle.signedPrekey)));
    final key = await _deriveAesKey(shared);

    final iv = _randomBytes(12);
    final box = await _aes.encrypt(utf8.encode(plaintext), secretKey: key, nonce: iv, aad: utf8.encode('$myId>$peerId'));
    final ciphertext = Uint8List.fromList(<int>[...iv, ...box.cipherText, ...box.mac.bytes]);
    final signature = await _sign(identity, <int>[...epkRaw, ...ciphertext]);

    return EncryptedPayload(
      header: jsonEncode(<String, dynamic>{'v': 1, 'epk': base64Encode(epkRaw), 'sig': base64Encode(signature)}),
      ciphertext: base64Encode(ciphertext),
    );
  }

  Future<DecryptResult> decryptFrom({
    required String myId,
    required String senderId,
    required String header,
    required String ciphertext,
    required String? senderIdentityKey,
  }) async {
    final prekey = _signedPrekey;
    if (prekey == null) throw StateError('E2EE not initialised');
    final parsed = jsonDecode(header) as Map<String, dynamic>;
    if (parsed['v'] != 1) throw const FormatException('Unsupported message version');

    final epkRaw = base64Decode(parsed['epk'] as String);
    final bytes = base64Decode(ciphertext);
    if (bytes.length < 12 + 16 + 1) throw const FormatException('Ciphertext is too short');

    final prekeyPair = EcKeyPairData(d: prekey.d, x: prekey.x, y: prekey.y, type: KeyPairType.p256);
    final shared = await _ecdh.sharedSecretKey(keyPair: prekeyPair, remotePublicKey: _publicFromRaw(epkRaw));
    final key = await _deriveAesKey(shared);

    final iv = bytes.sublist(0, 12);
    final macBytes = bytes.sublist(bytes.length - 16);
    final cipherText = bytes.sublist(12, bytes.length - 16);
    final plain = await _aes.decrypt(
      SecretBox(cipherText, nonce: iv, mac: Mac(macBytes)),
      secretKey: key,
      aad: utf8.encode('$senderId>$myId'),
    );

    bool? verified;
    if (senderIdentityKey != null) {
      try {
        verified = await _verify(base64Decode(senderIdentityKey), <int>[...epkRaw, ...bytes], base64Decode(parsed['sig'] as String));
      } on Object {
        verified = false;
      }
    }
    return DecryptResult(text: utf8.decode(plain), verified: verified);
  }
}
