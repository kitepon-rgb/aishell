import Foundation

@main
enum AIShellMCPMain {
    static func main() async {
        let outcome = await MCPServer().run()
        exit(outcome.exitCode)
    }
}
