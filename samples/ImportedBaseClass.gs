// file: ImportedBaseClass.gs
// Issue #296: a GSharp `class` can inherit from an IMPORTED (CLR) base class.
// Previously `class X : SomeImportedType { }` reported GS0157
// "Cannot find type" even though the type resolved for construction / static
// use. This sample proves the full scenario end-to-end:
//   * base-type name resolution against imported CLR types (simple + qualified)
//   * the emitted class extends the imported base in metadata
//   * base construction chains to the imported parameterless ctor
//   * inherited members (methods AND properties) are accessible on instances

package GSharp.Example.ImportedBaseClass

import System
import System.IO

// `Buffer` extends System.IO.MemoryStream via a simple (import-resolved) name.
// It also declares its own method alongside the inherited surface.
class Buffer : MemoryStream {
    func Describe(label string) string {
        return label
    }
}

var b = Buffer{}

// Inherited properties from the CLR base are visible on the GSharp instance.
Console.WriteLine(b.CanRead)
Console.WriteLine(b.CanWrite)

// Inherited method with an argument (int32 widened to the base's int64 param).
b.SetLength(3)
Console.WriteLine(b.Length)

// Inherited no-argument method returning a value.
var bytes = b.ToArray()
Console.WriteLine(bytes.Length)

// User-declared method on the derived class coexists with the inherited members.
Console.WriteLine(b.Describe("buffer"))

// A fully-qualified imported base type also resolves.
class Args : System.EventArgs {
}

var a = Args{}
Console.WriteLine(a.ToString())
