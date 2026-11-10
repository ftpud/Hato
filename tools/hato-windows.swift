// Enumerate visible windows without Accessibility automation or changing focus.
import Foundation
import CoreGraphics
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let result: [[String: Any]] = windows.compactMap { item in
    guard (item[kCGWindowLayer as String] as? Int) == 0,
          let id = item[kCGWindowNumber as String] as? Int,
          let owner = item[kCGWindowOwnerName as String] as? String,
          let bounds = item[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return ["id": id, "pid": item[kCGWindowOwnerPID as String] ?? 0, "owner": owner,
            "title": item[kCGWindowName as String] ?? "", "bounds": bounds]
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
