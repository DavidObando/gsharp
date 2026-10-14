// inventory: ExtensionBlockDeclaration — C# 14 `extension` container block, instance methods (probe)
// The headline C# 14 form: `extension(string s) { ... }` inside a static
// class, declaring instance-style extension methods invoked as s.Doubled().

package Corpus.Grid13.Constructs

import System

shared class ExtensionBlockDeclarationExtensions { }

@ExtensionOwner(typeof(ExtensionBlockDeclarationExtensions))
func (s string) Doubled() int32 {
    return s.Length * 2
}

@ExtensionOwner(typeof(ExtensionBlockDeclarationExtensions))
func (s string) Shout() string {
    return s.ToUpperInvariant() + "!"
}

shared class ExtensionBlockDeclarationFixture {
    func Run() {
        let word = "grid"
        Console.WriteLine("ExtensionBlockDeclaration: doubled=${word.Doubled()}")
        Console.WriteLine("ExtensionBlockDeclaration: shout=${word.Shout()}")
    }
}
