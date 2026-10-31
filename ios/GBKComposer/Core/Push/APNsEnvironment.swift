import Foundation

/// Which APNs gateway this build's device tokens belong to ("sandbox" | "production"),
/// sent to the server with `POST /api/push/register` — the server pushes via the
/// matching gateway and drops tokens the wrong gateway rejects (410/BadDeviceToken).
///
/// Derived from the build's provisioning, never from `#if DEBUG` (#137): a Release
/// build is not necessarily production — TestFlight builds are Release but Apple
/// issues them sandbox tokens, so the old DEBUG check registered every tester as
/// production and the server culled their installs on the first push.
///
/// Signals, in order:
/// 1. TestFlight: the embedded App Store profile carries `beta-reports-active`,
///    and TestFlight installs also hold a `sandboxReceipt`. Either means sandbox.
/// 2. The profile's `aps-environment` entitlement: `development` → sandbox
///    (Xcode/dev installs), `production` → production (ad hoc / enterprise).
/// 3. A sandbox receipt with no parseable entitlement → sandbox.
/// 4. An embedded profile with no parseable entitlement → sandbox: every
///    non–App Store install is a development install in practice (a distribution
///    profile's entitlements do parse, so this is not the ad hoc path).
/// 5. No embedded profile at all → production: App Store builds ship without one.
enum APNsEnvironment {
    static func resolve(apsEnvironment: String?, isTestFlight: Bool, hasEmbeddedProfile: Bool, receiptIsSandbox: Bool) -> String {
        if isTestFlight { return "sandbox" }
        switch apsEnvironment?.lowercased() {
        case "development": return "sandbox"
        case "production": return "production"
        default: break
        }
        if receiptIsSandbox { return "sandbox" }
        if hasEmbeddedProfile { return "sandbox" }
        return "production"
    }

    /// The environment for the running build, from its own embedded profile + receipt.
    static var current: String {
        let profile = embeddedProvisioningProfile()
        let entitlements = profile?["Entitlements"] as? [String: Any]
        let aps = (entitlements?["aps-environment"] as? String) ?? (profile?["aps-environment"] as? String)
        let beta = (entitlements?["beta-reports-active"] as? Bool) ?? (profile?["beta-reports-active"] as? Bool) ?? false
        let receiptIsSandbox = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
        return resolve(apsEnvironment: aps,
                       isTestFlight: beta,
                       hasEmbeddedProfile: profile != nil,
                       receiptIsSandbox: receiptIsSandbox)
    }

    static func embeddedProvisioningProfile() -> [String: Any]? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return nil }
        return provisioningProfile(in: data)
    }

    /// A `.mobileprovision` is a CMS-signed blob with a plist embedded verbatim;
    /// carve out the `<?xml … </plist>` span and parse it.
    static func provisioningProfile(in data: Data) -> [String: Any]? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.count) else { return nil }
        let plistData = data[start.lowerBound..<end.upperBound]
        return (try? PropertyListSerialization.propertyList(from: plistData, format: nil)) as? [String: Any]
    }
}
