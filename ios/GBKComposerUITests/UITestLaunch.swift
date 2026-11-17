import XCTest

/// Every UI-test launch must carry `-UITestMode` so the app sends `X-GBK-Test: 1`.
enum UITestLaunch {
    static let argument = "-UITestMode"

    static func apiRequest(_ url: URL) -> URLRequest {
        var req = URLRequest(url: url)
        req.setValue("1", forHTTPHeaderField: "X-GBK-Test")
        return req
    }
}

extension XCUIApplication {
    /// Attach `-UITestMode` (idempotent). Use before `launch()` or `open(_:)`.
    @discardableResult
    func preparedForUITest() -> Self {
        if !launchArguments.contains(UITestLaunch.argument) {
            launchArguments.append(UITestLaunch.argument)
        }
        return self
    }

    func launchInTestMode() {
        preparedForUITest().launch()
    }
}
