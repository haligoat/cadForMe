// cadSlop Menu: a native macOS menu-bar app. Lists the projects in ~/cadSlop (and each project's parts), recent
// projects, and opens any file or folder in cadSlop. Build: scripts/build-menubar.sh -> release/cadSlop Menu.app
import AppKit

let home = FileManager.default.homeDirectoryForCurrentUser
let projectsDir = home.appendingPathComponent("cadSlop", isDirectory: true)
let settingsFile = home.appendingPathComponent("Library/Application Support/cadslop/settings.json")
let cadSlopBundleID = "com.cadslop.app"

final class MenuApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private let menu = NSMenu()

    func applicationDidFinishLaunching(_ note: Notification) {
        try? FileManager.default.createDirectory(at: projectsDir, withIntermediateDirectories: true)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "cube.transparent", accessibilityDescription: "cadSlop")
            button.image?.isTemplate = true
            button.toolTip = "cadSlop"
        }
        menu.delegate = self
        item.menu = menu
    }

    // Rebuilt every time it opens, so new projects and recents show up straight away.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(action("Open cadSlop", #selector(openApp), key: "o"))
        menu.addItem(.separator())

        menu.addItem(header("cadSlop Folder"))
        let projects = listProjects()
        if projects.isEmpty { menu.addItem(disabled("No projects yet")) }
        for p in projects {
            let row = NSMenuItem(title: p.lastPathComponent, action: #selector(openURL(_:)), keyEquivalent: "")
            row.target = self; row.representedObject = p
            row.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
            let parts = listParts(in: p)
            if !parts.isEmpty {
                let sub = NSMenu()
                let whole = NSMenuItem(title: "Open project", action: #selector(openURL(_:)), keyEquivalent: "")
                whole.target = self; whole.representedObject = p
                sub.addItem(whole); sub.addItem(.separator())
                for f in parts {
                    let r = NSMenuItem(title: f.lastPathComponent.replacingOccurrences(of: ".part.json", with: ""), action: #selector(openURL(_:)), keyEquivalent: "")
                    r.target = self; r.representedObject = f
                    r.image = NSImage(systemSymbolName: "cube", accessibilityDescription: nil)
                    sub.addItem(r)
                }
                sub.addItem(.separator())
                let reveal = NSMenuItem(title: "Show in Finder", action: #selector(reveal(_:)), keyEquivalent: "")
                reveal.target = self; reveal.representedObject = p
                sub.addItem(reveal)
                row.submenu = sub
            }
            menu.addItem(row)
        }

        let recent = recentProjects().filter { r in !projects.contains { $0.standardizedFileURL.path == r.standardizedFileURL.path } }
        if !recent.isEmpty {
            menu.addItem(.separator())
            menu.addItem(header("Recent"))
            for r in recent {
                let row = NSMenuItem(title: r.lastPathComponent, action: #selector(openURL(_:)), keyEquivalent: "")
                row.target = self; row.representedObject = r; row.toolTip = r.path
                row.image = NSImage(systemSymbolName: "clock", accessibilityDescription: nil)
                menu.addItem(row)
            }
        }

        menu.addItem(.separator())
        menu.addItem(action("Open File or Folder…", #selector(openPanel), key: ""))
        menu.addItem(action("New Project…", #selector(newProject), key: "n"))
        menu.addItem(action("Show cadSlop Folder in Finder", #selector(showFolder), key: ""))
        menu.addItem(.separator())
        menu.addItem(action("Quit cadSlop Menu", #selector(quit), key: "q"))
    }

    // MARK: - data
    private func listProjects() -> [URL] {
        let items = (try? FileManager.default.contentsOfDirectory(at: projectsDir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        return items.map { $0.resolvingSymlinksInPath() }.filter(isProject).sorted { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }
    }
    private func isProject(_ u: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: u.appendingPathComponent(".cadslop").path) || fm.fileExists(atPath: u.appendingPathComponent("parts").path)
    }
    private func listParts(in project: URL) -> [URL] {
        let dir = project.appendingPathComponent("parts")
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.lastPathComponent.hasSuffix(".part.json") }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
    private func recentProjects() -> [URL] {
        guard let data = try? Data(contentsOf: settingsFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let recent = json["recent"] as? [String] else { return [] }
        return recent.filter { FileManager.default.fileExists(atPath: $0) && !$0.hasPrefix("/var/folders") }.prefix(6).map { URL(fileURLWithPath: $0) }
    }

    // MARK: - opening
    private func cadSlopURL() -> URL? {
        if let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: cadSlopBundleID) { return u }
        let guesses = ["/Applications/cadSlop.app", home.appendingPathComponent("Applications/cadSlop.app").path,
                       home.appendingPathComponent("Desktop/cadSlop/release/cadSlop-darwin-arm64/cadSlop.app").path]
        return guesses.first { FileManager.default.fileExists(atPath: $0) }.map { URL(fileURLWithPath: $0) }
    }
    private func open(_ urls: [URL]) {
        guard let app = cadSlopURL() else { alert("cadSlop isn't installed", "Build it with “npm run package” (it goes in release/), or copy cadSlop.app to Applications."); return }
        let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
        if urls.isEmpty { NSWorkspace.shared.openApplication(at: app, configuration: cfg) }
        else { NSWorkspace.shared.open(urls, withApplicationAt: app, configuration: cfg) { _, err in if let err { DispatchQueue.main.async { self.alert("Couldn't open in cadSlop", err.localizedDescription) } } } }
    }
    @objc private func openApp() { open([]) }
    @objc private func openURL(_ sender: NSMenuItem) { if let u = sender.representedObject as? URL { open([u]) } }
    @objc private func reveal(_ sender: NSMenuItem) { if let u = sender.representedObject as? URL { NSWorkspace.shared.activateFileViewerSelecting([u]) } }
    @objc private func showFolder() { NSWorkspace.shared.open(projectsDir) }
    @objc private func openPanel() {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.title = "Open in cadSlop"; p.canChooseDirectories = true; p.canChooseFiles = true; p.allowsMultipleSelection = false
        p.directoryURL = projectsDir
        if p.runModal() == .OK, let u = p.url { open([u]) }
    }
    @objc private func newProject() {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSSavePanel()
        p.title = "New cadSlop project"; p.prompt = "Create"; p.nameFieldLabel = "Project name:"; p.nameFieldStringValue = "New project"
        p.directoryURL = projectsDir; p.canCreateDirectories = true
        if p.runModal() == .OK, let u = p.url {
            do { try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true); open([u]) }
            catch { alert("Couldn't create the folder", error.localizedDescription) }
        }
    }
    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - helpers
    private func action(_ title: String, _ sel: Selector, key: String) -> NSMenuItem { let i = NSMenuItem(title: title, action: sel, keyEquivalent: key); i.target = self; return i }
    private func header(_ title: String) -> NSMenuItem {
        if #available(macOS 14.0, *) { return NSMenuItem.sectionHeader(title: title) }
        return disabled(title)
    }
    private func disabled(_ title: String) -> NSMenuItem { let i = NSMenuItem(title: title, action: nil, keyEquivalent: ""); i.isEnabled = false; return i }
    private func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert(); a.messageText = title; a.informativeText = text; a.runModal()
    }
}

let app = NSApplication.shared
let delegate = MenuApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
app.run()
