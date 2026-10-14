// inventory: ExtensionBlockDeclaration — extension properties via extension blocks (probe)
// C# 14 instance extension properties: a get-only expression-bodied property
// and a get-accessor property on a receiver parameter.

package Corpus.Grid13.Constructs

import System

shared class ExtensionBlockPropertyExtensions { }

@ExtensionOwner(typeof(ExtensionBlockPropertyExtensions))
func (s string) DoubledLength() int32 -> s.Length * 2

@ExtensionOwner(typeof(ExtensionBlockPropertyExtensions))
func (s string) FirstAndLast() string {
    if s.Length == 0 {
        return "<empty>"
    }
    return "${s[0]}..${s[s.Length - 1]}"
}

shared class ExtensionBlockPropertyFixture {
    func Run() {
        let word = "corpus"
        Console.WriteLine("ExtensionBlockProperty: doubledLength=${word.DoubledLength()}")
        Console.WriteLine("ExtensionBlockProperty: firstAndLast=${word.FirstAndLast()}")
    }
}
