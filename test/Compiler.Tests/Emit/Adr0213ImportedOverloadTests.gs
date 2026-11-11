// <copyright file="Adr0213ImportedOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import SourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import System
import System.Linq
import Xunit

/// ADR-0213 L1 (#5459): the CLR resolver can select an imported overload with omitted optional parameters, so a loop
/// whose call can bind it through a conversion operator removes a by-reference fact, as on main.
open class Adr0213ImportedOverloadTests {
    private const LibrarySource string = `namespace OptLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class S {
    public void Use(object o) { }
    public void Use(Payload p, int extra = 0) { }
}`

    private const ParamsLibrarySource string = `namespace ParamsLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class S {
    public void Use(params Payload[] values) { }
}`

    @Fact
    func ImportedParamsOverloadInExpandedForm_RemovesAByReferenceFact() {
        let source = `package T
import System
import ParamsLib
func Run(ref text string?, s S, tok Token) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        s.Use(tok)
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(ParamsLibrarySource, assemblyName: "ParamsLib")
        using let references = fixture.RuntimeReferences()
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@7:16", string.Join(" ", errors))
    }

    private const ExtensionLibrarySource string = `namespace ExtLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class R { public void Run() { } }
public class Q { public System.Action Run = () => { }; }
public class S {
    public void Use(string s) { }
    public R Create(string x) => new R();
}
public static class Ext {
    public static void Use(this S s, Payload p) { }
    public static Q Create(this S s) => new Q();
}`

    @Theory
    @InlineData("s.Use(tok)")
    @InlineData("s.Create().Run()")
    func ImportedExtensionBesideAnInstanceMethod_RemovesAByReferenceFact(call string) {
        let source = `package T
import System
import ExtLib
func Run(ref text string?, s S, tok Token) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        ` + call + `
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(ExtensionLibrarySource, assemblyName: "ExtLib")
        using let references = fixture.RuntimeReferences()
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@7:16", string.Join(" ", errors))
    }

    @Theory
    @InlineData("s.Use(\"ab\")")
    @InlineData("s.Create(\"ab\").Run()")
    func ApplicableInstanceMethodBesideAnImportedExtension_KeepsAByReferenceFact(call string) {
        let source = `package T
import System
import ExtLib
func Run(ref text string?, s S) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        ` + call + `
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(ExtensionLibrarySource, assemblyName: "ExtLib")
        using let references = fixture.RuntimeReferences()
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("", string.Join(" ", errors))
    }

    @Fact
    func ImportedOptionalOverloadWithAConversion_RemovesAByReferenceFact() {
        let source = `package T
import System
import OptLib
func Run(ref text string?, s S, tok Token) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        s.Use(tok)
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(LibrarySource, assemblyName: "OptLib")
        using let references = fixture.RuntimeReferences()
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@7:16", string.Join(" ", errors))
    }

    private const FriendInternalLibrarySource string = `[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("FriendApp")]
namespace FriendLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class R { public void Run() { } }
public class Q { public System.Action Run = () => { }; }
public class S {
    public void Use(object o, int extra = 0) { }
    internal void Use(Payload p) { }
    public R Create(object x) => new R();
    internal Q Create(string x) => new Q();
}
public static class Ext {
    public static Q Create(this S s) => new Q();
}`

    @Theory
    @InlineData("s.Use(tok)")
    @InlineData(`s.Create("ab").Run()`)
    func FriendAssemblyInternalOverloadWithAConversion_RemovesAByReferenceFact(call string) {
        let source = `package T
import System
import FriendLib
func Run(ref text string?, s S, tok Token) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        ` + call + `
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(FriendInternalLibrarySource, assemblyName: "FriendLib")
        using let references = fixture.RuntimeReferences()
        references.CurrentAssemblyName = "FriendApp"
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@7:16", string.Join(" ", errors))
    }

    private const ConstantNarrowingLibrarySource string = `namespace NarrowLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class S {
    public void Use(byte b, Payload p) { }
    public void Use(long l, object o) { }
    public void TakeByte(byte b) { }
}`

    @Theory
    @InlineData("s.Use(1, tok)", "GS0158@7:16")
    @InlineData("s.TakeByte(1)", "")
    func ImportedConstantNarrowingOverload_MatchesNormalBinding(call string, expected string) {
        let source = `package T
import System
import NarrowLib
func Run(ref text string?, s S, tok Token) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        ` + call + `
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(ConstantNarrowingLibrarySource, assemblyName: "NarrowLib")
        using let references = fixture.RuntimeReferences()
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal(expected, string.Join(" ", errors))
    }

    private const ErasureAndInterpolationLibrarySource string = `namespace ErasureLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class S {
    public void UseEnum(int n, Token t) { }
    public void UseEnum(object o, Payload p) { }
    public void UseFmt(System.FormattableString f, System.DateTimeOffset d) { }
    public void UseFmt(object a, object b) { }
    public static void UseStaticFmt(System.FormattableString f, System.DateTimeOffset d) { }
    public static void UseStaticFmt(object a, object b) { }
    public string Describe(System.FormattableString f) => "fmt:" + f.Format + ":" + f.ArgumentCount;
    public string Describe(object o) => "obj:" + o;
    public static string DescribeStatic(System.FormattableString f) => "sfmt:" + f.Format + ":" + f.ArgumentCount;
    public static string DescribeStatic(object o) => "sobj:" + o;
    public void UseList(System.Collections.Generic.List<object> xs, Token t) { }
    public void UseList(object o, Payload p) { }
    public void UseDisp(System.IDisposable d, System.DateTimeOffset dt, int pad = 0) { }
    public void UseDisp(object a, object b) { }
}`

    @Theory
    @InlineData("s.UseEnum(kind, tok)", "GS0158@13:16")
    @InlineData(`s.UseFmt("n=${n}", dt)`, "GS0158@13:16")
    @InlineData(`S.UseStaticFmt(("n=${n}"), dt)`, "GS0158@13:16")
    @InlineData("s.UseList(xs, tok)", "GS0158@13:16")
    @InlineData("s.UseDisp(c, dt)", "GS0158@13:16")
    func ImportedErasureAndInterpolationOverloadsWithAConversion_RemoveAByReferenceFact(call string, expected string) {
        let source = `package T
import System
import System.Collections.Generic
import ErasureLib
enum Kind { A }
struct Item { var V int32 }
class DisposableError : Exception, IDisposable {
    func Dispose() { }
}
func Run(ref text string?, s S, kind Kind, xs List[Item], c DisposableError, tok Token, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        ` + call + `
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(ErasureAndInterpolationLibrarySource, assemblyName: "ErasureLib")
        using let references = fixture.RuntimeReferences()
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal(expected, string.Join(" ", errors))
    }

    @Fact
    func ParenthesizedFormattableStringArgument_EmitsAndRuns() {
        let source = `package T
import System
import ErasureLib
func Main() {
    var n = 7
    let s = S()
    Console.WriteLine(s.Describe(("n=${n}")) + "|" + S.DescribeStatic(("n=${n}")))
}`
        using let lib = CSharpFixture(ErasureAndInterpolationLibrarySource, assemblyName: "ErasureLib")
        using let fixture = NativeSliceLanguageTests.Fixture()
        System
            .IO
            .File
            .Copy(
            lib.AssemblyPath,
            System.IO.Path.Combine(fixture.Directory, System.IO.Path.GetFileName(lib.AssemblyPath))
        )
        let exe = fixture.Compile(source, "ParenthesizedFmt", executable: true, "/reference:" + lib.AssemblyPath)
        IlVerifier.Verify(exe, []string{lib.AssemblyPath})
        Assert.Equal("fmt:n={0}:1|sfmt:n={0}:1", fixture.Run(exe).Trim())
    }

    private const SuspendingLibrarySource string = `namespace Gsharp.Concurrency {
    [System.AttributeUsage(System.AttributeTargets.Method)]
    public sealed class SuspendingAttribute : System.Attribute { }
}
namespace SuspendLib {
    public class Helper {
        [Gsharp.Concurrency.Suspending]
        public System.Threading.Tasks.ValueTask<int> Make() => default;
    }
}`

    @Fact
    func ImportedSuspendingCallResult_SelectsUnwrappedOverloadWithConversion() {
        let source = `package T
import System
import System.Threading.Tasks
import SuspendLib
func Use(v int32, d DateTimeOffset) { }
func Use(t ValueTask[int32], o object) { }
func Run(ref text string?, helper Helper, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(helper.Make(), dt)
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(SuspendingLibrarySource, assemblyName: "SuspendLib")
        using let references = fixture.RuntimeReferences()
        let errors = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError && diagnostic.Id == "GS0158")
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@10:16", string.Join(" ", errors))
    }
}
