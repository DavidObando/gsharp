// inventory: ExtensionBlockDeclaration — static extension members in extension blocks (probe)
// C# 14 static extension members declared with a receiverless
// `extension(string)` block and invoked through the type: string.Meaning,
// string.Repeat(...).

package Corpus.Grid13.Constructs

import System
import System.Text

shared class ExtensionBlockStaticExtensions {
    prop Meaning string -> "forty-two"

    func Repeat(value string, count int32) string {
        let builder = StringBuilder()
        for var i = 0; i < count; i++ {
            builder.Append(value)
        }
        return builder.ToString()
    }
}

shared class ExtensionBlockStaticFixture {
    func Run() {
        Console.WriteLine("ExtensionBlockStatic: meaning=${ExtensionBlockStaticExtensions.Meaning}")
        Console.WriteLine("ExtensionBlockStatic: repeat=${ExtensionBlockStaticExtensions.Repeat("ab", 3)}")
    }
}
