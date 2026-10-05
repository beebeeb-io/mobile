import ExpoModulesCore
import Foundation

/// Task 1746 — the JS-facing side of `beebeeb_core::onboarding` (task 1744):
/// the password-policy evaluator, the k-anonymity breach check and the signup
/// ceremony state machine. ALL logic lives in core; this file only keeps the
/// UniFFI handles alive between bridge calls, converts types, and maps errors
/// to stable machine codes.
///
/// Why handles in a registry: the ceremony holds the password, the recovery
/// phrase and the master key in Rust memory in zeroizing buffers. JS gets an
/// opaque integer id (like `masterKeyHandles` in `BeebeebCryptoModule`), never
/// those bytes. The three things that DO cross the bridge are the ones the flow
/// cannot avoid:
///   - the phrase words, once, while the phrase screen renders them
///     (`ceremonyPhrase`; the Rust copy is wiped when the phrase is confirmed);
///   - the OPAQUE messages (`startRegistration` / `finishRegistration`);
///   - the master key bytes, once, at `ceremonyAccountCreated`, because the
///     existing vault code stores the key through `storeMasterKey` in
///     crypto-context.tsx (the same hand-over `recoverFromPhrase` does today).
///
/// A JS handle id is released with `*Release`; `ceremonyAbandon` wipes the secrets
/// first (a binding handle is freed on ARC's schedule, so the explicit wipe on
/// back / cancel / error exits is what the core contract asks of every client).
///
/// Nothing here logs a password, a phrase, a key, an email or an error detail.
final class OnboardingBridge {
  static let shared = OnboardingBridge()

  private let lock = NSLock()
  private var ceremonies: [Int: SignupCeremonyHandle] = [:]
  private var breachChecks: [Int: BreachCheckHandle] = [:]
  private var nextId: Int = 1

  private init() {}

  // MARK: registry

  private func putCeremony(_ value: SignupCeremonyHandle) -> Int {
    lock.lock()
    defer { lock.unlock() }
    let id = nextId
    nextId += 1
    ceremonies[id] = value
    return id
  }

  private func putBreach(_ value: BreachCheckHandle) -> Int {
    lock.lock()
    defer { lock.unlock() }
    let id = nextId
    nextId += 1
    breachChecks[id] = value
    return id
  }

  private func ceremony(_ id: Int) throws -> SignupCeremonyHandle {
    lock.lock()
    defer { lock.unlock() }
    guard let c = ceremonies[id] else { throw OnboardingBridge.unknownHandle() }
    return c
  }

  private func breach(_ id: Int) throws -> BreachCheckHandle {
    lock.lock()
    defer { lock.unlock() }
    guard let b = breachChecks[id] else { throw OnboardingBridge.unknownHandle() }
    return b
  }

  private static func unknownHandle() -> Exception {
    Exception(name: "OnboardingException", description: "Unknown onboarding handle", code: "ERR_ONBOARDING_UNKNOWN_HANDLE")
  }

  // MARK: errors

  /// Core's `OnboardingError` becomes a stable code the UI branches on. The
  /// description is a fixed sentence per code: never the Rust text, which can
  /// carry a length or a count.
  static func code(for error: OnboardingError) -> String {
    switch error {
    case .StepNotDone: return "step_not_done"
    case .InvalidState: return "invalid_state"
    case .PasswordMismatch: return "password_mismatch"
    case .PasswordTooShort: return "password_too_short"
    case .PasswordBreached: return "password_breached"
    case .BreachCheckBlocked: return "breach_check_blocked"
    case .BreachCheckMissing: return "breach_check_missing"
    case .BreachCheckStale: return "breach_check_stale"
    case .BreachPrefixMismatch: return "breach_prefix_mismatch"
    case .PhraseUnavailable: return "phrase_unavailable"
    case .PhraseAnswerCount: return "phrase_answer_count"
    case .PhraseWordMismatch: return "phrase_word_mismatch"
    case .Crypto: return "crypto"
    }
  }

  static func mapped(_ error: Error) -> Error {
    if let e = error as? OnboardingError {
      let code = OnboardingBridge.code(for: e)
      return Exception(
        name: "OnboardingException",
        description: "Onboarding step failed: \(code)",
        code: "ERR_ONBOARDING_\(code.uppercased())"
      )
    }
    return Exception(
      name: "OnboardingException",
      description: "Onboarding step failed: crypto",
      code: "ERR_ONBOARDING_CRYPTO"
    )
  }

  private func run<T>(_ body: () throws -> T) throws -> T {
    do { return try body() } catch { throw OnboardingBridge.mapped(error) }
  }

  // MARK: password

  func evaluatePasswordForUI(_ password: String, minLength: Int) -> [String: Any] {
    let e = evaluatePassword(password: password, minLength: UInt32(max(0, minLength)))
    return OnboardingBridge.dictionary(e)
  }

  private static func dictionary(_ e: PasswordEvaluationDto) -> [String: Any] {
    let strength: String
    switch e.strength {
    case .tooShort: strength = "too_short"
    case .fair: strength = "fair"
    case .good: strength = "good"
    case .strong: strength = "strong"
    }
    let hint: String
    switch e.hint {
    case .none: hint = "none"
    case .needMoreCharacters: hint = "need_more_characters"
    case .mixCaseAndAddNumberOrSymbol: hint = "mix_case_and_add_number_or_symbol"
    case .mixCase: hint = "mix_case"
    case .addNumberOrSymbol: hint = "add_number_or_symbol"
    }
    return [
      "length": Int(e.length),
      "minLength": Int(e.minLength),
      "missingCharacters": Int(e.missingCharacters),
      "meetsMinimum": e.meetsMinimum,
      "hasMixedCase": e.hasMixedCase,
      "hasNumberOrSymbol": e.hasNumberOrSymbol,
      "strength": strength,
      "level": Int(e.level),
      "hint": hint,
    ]
  }

  // MARK: breach check

  func breachNew(_ password: String) -> Int {
    putBreach(BreachCheckHandle(password: password))
  }

  func breachPrefix(_ id: Int) throws -> String {
    try breach(id).prefix()
  }

  func breachEvaluate(_ id: Int, requestedPrefix: String, body: String?, failOpen: Bool) throws -> [String: Any] {
    let handle = try breach(id)
    return try run {
      let verdict = try handle.evaluate(requestedPrefix: requestedPrefix, body: body, failOpen: failOpen)
      switch verdict {
      case .clean: return ["kind": "clean"]
      case let .breached(count): return ["kind": "breached", "count": Double(count)]
      case .checkFailedAllowed: return ["kind": "check_failed_allowed"]
      case .checkFailedBlocked: return ["kind": "check_failed_blocked"]
      case .notRequired: return ["kind": "not_required"]
      }
    }
  }

  func breachRelease(_ id: Int) {
    lock.lock()
    breachChecks.removeValue(forKey: id)
    lock.unlock()
  }

  // MARK: ceremony

  func ceremonyNew(
    minLength: Int,
    emailVerificationRequired: Bool,
    verifyWordCount: Int,
    breachCheckRequired: Bool,
    breachFailOpen: Bool
  ) -> Int {
    let handle = SignupCeremonyHandle(
      minLength: UInt32(max(0, minLength)),
      emailVerificationRequired: emailVerificationRequired,
      verifyWordCount: UInt32(max(0, verifyWordCount)),
      breachCheckRequired: breachCheckRequired,
      breachFailOpen: breachFailOpen
    )
    return putCeremony(handle)
  }

  func ceremonyEmailVerified(_ id: Int) throws { try ceremony(id).emailVerified() }
  func ceremonyEmailChanged(_ id: Int) throws { try ceremony(id).emailChanged() }
  func ceremonyEmailTicketInvalidated(_ id: Int) throws { try ceremony(id).emailTicketInvalidated() }
  func ceremonyRegistrationFailed(_ id: Int) throws { try ceremony(id).registrationFailed() }

  func ceremonySetPassword(_ id: Int, password: String, confirmation: String, breachId: Int?) throws -> [String: Any] {
    let c = try ceremony(id)
    let b: BreachCheckHandle? = try breachId.map { try breach($0) }
    return try run {
      OnboardingBridge.dictionary(try c.setPassword(password: password, confirmation: confirmation, breach: b))
    }
  }

  func ceremonyBeginPhrase(_ id: Int) throws {
    let c = try ceremony(id)
    try run { try c.beginPhrase() }
  }

  func ceremonyPhrase(_ id: Int) throws -> String {
    let c = try ceremony(id)
    return try run { try c.phrase() }
  }

  func ceremonyAcknowledgePhrase(_ id: Int) throws {
    let c = try ceremony(id)
    try run { try c.acknowledgePhrase() }
  }

  func ceremonyChallengePositions(_ id: Int) throws -> [Int] {
    let c = try ceremony(id)
    return try run { try c.challengePositions().map { Int($0) } }
  }

  func ceremonyConfirmPhrase(_ id: Int, answers: [String]) throws {
    let c = try ceremony(id)
    try run { try c.confirmPhrase(answers: answers) }
  }

  func ceremonyStartRegistration(_ id: Int) throws -> Data {
    let c = try ceremony(id)
    return try run { try c.startRegistration() }
  }

  func ceremonyFinishRegistration(_ id: Int, serverMessage: Data) throws -> [String: Data] {
    let c = try ceremony(id)
    return try run {
      let r = try c.finishRegistration(serverMessage: serverMessage)
      return ["upload": r.upload, "x25519Public": r.x25519Public, "recoveryCheck": r.recoveryCheck]
    }
  }

  /// The pending step as the SERVER's step id (`save_recovery_phrase` for both
  /// phrase parts), or `done`.
  func ceremonyStep(_ id: Int) throws -> String {
    let c = try ceremony(id)
    return ceremonyStepSpecId(step: c.step())
  }

  /// The server accepted `register-finish`. Returns the master key bytes ONCE for
  /// the vault code to store (see the file comment); the ceremony wipes the rest.
  func ceremonyAccountCreated(_ id: Int) throws -> Data {
    let c = try ceremony(id)
    return try run {
      let key = try c.accountCreated()
      return try key.exportForKeychain()
    }
  }

  func ceremonyAbandon(_ id: Int) {
    lock.lock()
    let c = ceremonies[id]
    lock.unlock()
    c?.abandon()
  }

  /// Wipe, then forget the handle.
  func ceremonyRelease(_ id: Int) {
    lock.lock()
    let c = ceremonies.removeValue(forKey: id)
    lock.unlock()
    c?.abandon()
  }
}
