import Foundation

/// UI-test traffic marker. CI launches the app with `-UITestMode`; production never does.
/// Native API, analytics and media requests send `X-GBK-Test: 1`. The studio WKWebView also
/// plants cookie `gbk_test=1` and patches fetch / XHR / sendBeacon, because a header on the
/// first page load does not carry over to the page's own calls. The server already skips
/// analytics and signup counts for the header; it must treat cookie `gbk_test=1` the same
/// (document navigations, WebSocket upgrades, and anything the patch misses).
enum UITestMode {
    static let argument = "-UITestMode"
    static let headerName = "X-GBK-Test"
    static let headerValue = "1"
    static let cookieName = "gbk_test"

    static var isEnabled: Bool { ProcessInfo.processInfo.arguments.contains(argument) }

    static func apply(_ request: inout URLRequest) {
        guard isEnabled else { return }
        request.setValue(headerValue, forHTTPHeaderField: headerName)
    }

    static func request(_ url: URL) -> URLRequest {
        var req = URLRequest(url: url)
        apply(&req)
        return req
    }

    static func cookie(for host: String) -> HTTPCookie? {
        HTTPCookie(properties: [
            .domain: host,
            .path: "/",
            .name: cookieName,
            .value: headerValue,
            .secure: "TRUE",
            .expires: Date(timeIntervalSinceNow: 86_400),
        ])
    }

    /// Document-start script (wrap with `WebTrust.onlyOnTrustedOrigin`).
    static let headerScript = """
    (function(){
      var H='X-GBK-Test', V='1';
      var _fetch=window.fetch;
      if(_fetch){
        window.fetch=function(input, init){
          init=Object.assign({}, init||{});
          var headers=new Headers(init.headers||(input&&input.headers)||undefined);
          headers.set(H,V);
          init.headers=headers;
          return _fetch.call(this,input,init);
        };
      }
      var _send=XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send=function(){
        try{this.setRequestHeader(H,V);}catch(e){}
        return _send.apply(this,arguments);
      };
      if(navigator.sendBeacon){
        var _beacon=navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon=function(url,data){
          try{
            var headers=new Headers(); headers.set(H,V);
            fetch(url,{method:'POST',body:data,headers:headers,keepalive:true,credentials:'include'});
            return true;
          }catch(e){return _beacon(url,data);}
        };
      }
    })();
    """
}
