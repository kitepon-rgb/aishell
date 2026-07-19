import Foundation

@main
enum AIShellMCPMain {
    static func main() async {
        await MCPServer().run()
    }
}
