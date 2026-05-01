import ExpoModulesCore

// Placeholder module. All functions throw NotLinkedError until BeebeebCore.xcframework
// is built (repos/core/build-ios.sh) and linked via the app.plugin.js config plugin.
public class BeebeebCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BeebeebCrypto")

    AsyncFunction("generateRecoveryPhrase") { () throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("recoverFromPhrase") { (_: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("encryptChunk") { (_: Data, _: Data) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("decryptChunk") { (_: Data, _: Data, _: Data) throws -> Data in
      throw NotLinkedError()
    }

    AsyncFunction("encryptMetadata") { (_: Data, _: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("decryptMetadata") { (_: Data, _: Data, _: Data) throws -> String in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueRegistrationStart") { (_: String, _: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueRegistrationFinish") { (_: Data, _: Data) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueLoginStart") { (_: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueLoginFinish") { (_: Data, _: Data) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("deriveFileKey") { (_: Data, _: String) throws -> Data in
      throw NotLinkedError()
    }

    AsyncFunction("storeKeyInKeychain") { (_: Data, _: String) throws in
      throw NotLinkedError()
    }

    AsyncFunction("loadKeyFromKeychain") { (_: String) throws -> Data? in
      throw NotLinkedError()
    }
  }
}

private struct NotLinkedError: LocalizedError {
  var errorDescription: String? {
    "BeebeebCore.xcframework not linked — run repos/core/build-ios.sh first"
  }
}
