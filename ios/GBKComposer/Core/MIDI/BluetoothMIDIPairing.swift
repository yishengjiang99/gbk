import CoreAudioKit
import UIKit

/// Apple's Bluetooth LE MIDI pairing sheet (CABTMIDICentralViewController), presented modally over the top
/// view controller so it never sits on the studio's toolbar or input. Paired devices show up as CoreMIDI
/// sources and reach the web view through MIDIInputHub's hot-plug notifications.
@MainActor
enum BluetoothMIDIPairing {
    static func present() {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let central = CABTMIDICentralViewController()
        central.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak top] _ in top?.dismiss(animated: true) })
        central.title = "Bluetooth MIDI"
        let nav = UINavigationController(rootViewController: central)
        nav.modalPresentationStyle = .formSheet
        top.present(nav, animated: true)
    }
}
