// <copyright file="BaseMemberAccessibilityBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

/// Accessibility of base members reached through `base.E += h` and
/// `base.P ??= v`. The nearest member of the name still hides farther
/// ones, but a member the derived class cannot reach is reported rather than
/// bound: a `private` source event, a `private` or non-friend
/// `internal` imported event (whose accessor call would otherwise fail
/// at run time with MethodAccessException). A friend assembly's
/// `internal` event or setter is reachable, as for plain
/// `base.P = v`.
class BaseMemberAccessibilityBinderTests {
    @Fact
    func PrivateSourceBaseEvent_IsReportedInaccessible() {
        const source = `import System

open class Base {
    private event Changed EventHandler?
    protected event Guarded EventHandler?
}

class Derived : Base {
    func Go() {
        base.Changed += func (s object?, e EventArgs) { }
        base.Guarded += func (s object?, e EventArgs) { }
    }
}`
        let diagnostics = EmittedOracle
            .Evaluate(source)
            .Diagnostics
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToArray()
        let inaccessible = Assert.Single(diagnostics)
        Assert.Equal("GS0472", inaccessible.Id)
        Assert.Contains("Changed", inaccessible.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("PrivateChanged", "BaseAccess.Friend")
    @InlineData("InternalChanged", "BaseAccess.Stranger")
    func UnreachableImportedBaseEvent_IsRejected(eventName string, assemblyName string) {
        let result = CompileAgainstLibrary((`import System
import BaseAccess.Library

class Derived : Source {
    func Go() {
        base.` + "$eventName" + ` += func (s object?, e EventArgs) { }
    }
}`), assemblyName)
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (d BaseMemberAccessibilityBinderTests.DiagnosticInfo) -> d.Message!!.Contains(
                eventName,
                StringComparison.Ordinal
            )
        )
    }

    @Theory
    @InlineData("InternalChanged", "BaseAccess.Friend")
    @InlineData("ProtectedChanged", "BaseAccess.Stranger")
    func ReachableImportedBaseEvent_Binds(eventName string, assemblyName string) {
        let result = CompileAgainstLibrary((`import System
import BaseAccess.Library

class Derived : Source {
    func Go() {
        base.` + "$eventName" + ` += func (s object?, e EventArgs) { }
        base.` + "$eventName" + ` -= func (s object?, e EventArgs) { }
    }
}`), assemblyName)
        Assert.True(result.Success, Describe(result))
    }

    @Fact
    func NullCoalescingAssignment_ImportedBaseInternalSetter_FriendBinds() {
        let result = CompileAgainstLibrary(`import BaseAccess.Library

class Derived : Source {
    func Go() {
        base.Label = "plain"
        base.Label ??= "coalesced"
    }
}`, FriendName)
        Assert.True(result.Success, Describe(result))
    }

    @Theory
    @InlineData("Label", "BaseAccess.Stranger")
    @InlineData("Tag", "BaseAccess.Friend")
    func NullCoalescingAssignment_UnreachableImportedBaseSetter_IsRejected(property string, assemblyName string) {
        let result = CompileAgainstLibrary((`import BaseAccess.Library

class Derived : Source {
    func Go() {
        base.` + "$property" + ` ??= "coalesced"
    }
}`), assemblyName)
        Assert.False(result.Success)
    }

    @Fact
    func NearerSourceValueMember_HidesFartherBaseEvent() {
        // `Mid` declares value members named like `Far`'s events. The nearer
        // member hides the event, so `base.Count += 1` is integer compound
        // assignment and `base.Label += "!"` string concatenation.
        const source = `import System

open class Far {
    event Count EventHandler?
    event Label EventHandler?
}

open class Mid : Far {
    var Count int32 = 1
    var label string = "a"
    prop Label string {
        get -> label
        set { label = value }
    }
}

class Derived : Mid {
    func Go() string {
        base.Count += 1
        base.Label += "!"
        return "${base.Count} ${base.Label}"
    }
}

Console.WriteLine(Derived().Go())`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.Equal("2 a!" + Environment.NewLine, result.Output)
    }

    @Fact
    func NearerImportedValueMember_HidesFartherBaseEvent() {
        let result = CompileAgainstLibrary(`import BaseAccess.Library

class Derived : HidingMid {
    func Go() {
        base.Count += 1
        base.Label += "!"
    }
}`, StrangerName)
        Assert.True(result.Success, Describe(result))
    }

    @Fact
    func ImportedTypeNamedBase_StaticCall_Binds() {
        // `base` is contextual: an imported type named `base` keeps its
        // ordinary meaning in `base.M()`, directly and in a function literal.
        let result = CompileAgainstLibrary(`import BaseAccess.Named

func Direct() string -> base.M()

func InLiteral() string {
    let f = () -> base.M()
    return f()
}`, StrangerName)
        Assert.True(result.Success, Describe(result))
    }

    @Theory
    @InlineData("StaticHolder.ReadHidden = 3")
    @InlineData("let w = StaticHolder.WriteHidden")
    func ImportedProtectedStaticProperty_VisibleAccessor_Binds(statement string) {
        let result = CompileAgainstLibrary((`import BaseAccess.Library

class Derived : StaticHolder {
    func Go() {
        ` + "$statement" + `
    }
}`), StrangerName)
        Assert.True(result.Success, Describe(result))
    }

    @Theory
    @InlineData("let r = StaticHolder.ReadHidden")
    @InlineData("StaticHolder.WriteHidden = 3")
    @InlineData("StaticHolder.ReadHidden += 1")
    @InlineData("StaticHolder.WriteHidden += 1")
    @InlineData("Derived.ReadHidden++")
    func ImportedProtectedStaticProperty_HiddenAccessor_IsRejected(statement string) {
        // A read calls the getter and a write the setter; a compound
        // assignment needs both. A private accessor is not callable from the
        // derived class even though the property as a whole is protected.
        let result = CompileAgainstLibrary((`import BaseAccess.Library

class Derived : StaticHolder {
    func Go() {
        ` + "$statement" + `
    }
}`), StrangerName)
        Assert.False(result.Success)
    }

    @Fact
    func SourceProtectedStaticProperty_CompoundNeedsBothAccessors() {
        const source = `open class Holder {
    shared {
        var r int32 = 1
        protected prop ReadHidden int32 {
            private get -> r
            set { r = value }
        }
    }
}

class Derived : Holder {
    func Go() {
        Holder.ReadHidden = 3
        Holder.ReadHidden += 1
    }
}`
        let errors = EmittedOracle
            .Evaluate(source)
            .Diagnostics
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToArray()
        let inaccessible = Assert.Single(errors)
        Assert.Equal("GS0472", inaccessible.Id)
    }

    @Theory
    @InlineData("base.Fixed += 1")
    @InlineData("base.Fixed++")
    @InlineData("--base.Fixed")
    func ImportedReadOnlyBaseField_CompoundIsRejected(statement string) {
        let result = CompileAgainstLibrary((`import BaseAccess.Library

class Derived : ReadOnlyHolder {
    func Go() {
        ` + "$statement" + `
    }
}`), StrangerName)
        Assert.False(result.Success)
    }

    @Theory
    @InlineData("StaticHolder.NullableWriteHidden ??= \"x\"")
    @InlineData("this.InstanceWriteHidden ??= \"x\"")
    @InlineData("InstanceWriteHidden ??= \"x\"")
    func NullCoalescingAssignment_PrivateClrSetter_IsRejected(statement string) {
        // `??=` writes through the setter, which the derived class cannot
        // call when it is private, even though the getter is visible.
        let result = CompileAgainstLibrary((`import BaseAccess.Library

class Derived : StaticHolder {
    func Go() {
        ` + "$statement" + `
    }
}`), FriendName)
        Assert.False(result.Success)
    }

    @Theory
    @InlineData("BaseAccess.Friend", true)
    @InlineData("BaseAccess.Stranger", false)
    func NullCoalescingAssignment_InternalClrSetter_FollowsFriendship(assemblyName string, expectSuccess bool) {
        let result = CompileAgainstLibrary(`import BaseAccess.Library

class Derived : StaticHolder {
    func Go() {
        StaticHolder.FriendSettable ??= "x"
    }
}`, assemblyName)
        Assert.True(result.Success == expectSuccess, Describe(result))
    }

    @Fact
    func NullCoalescingAssignment_PrivateSourceSetter_IsRejectedOutsideTheDeclaringType() {
        const source = `open class Holder {
    var s string?
    protected prop P string? {
        get -> s
        private set { s = value }
    }

    func Own() {
        P ??= "own"
    }

    shared {
        var t string?
        protected prop Q string? {
            get -> t
            private set { t = value }
        }
    }
}

class Derived : Holder {
    func Go() {
        this.P ??= "x"
        P ??= "y"
        Holder.Q ??= "z"
    }
}`
        let errors = EmittedOracle
            .Evaluate(source)
            .Diagnostics
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToArray()
        Assert.Equal(3, errors.Length)
        Assert.All(errors, (error GSharp.Core.CodeAnalysis.Diagnostic) -> Assert.Equal("GS0472", error.Id))
    }

    private data struct CompileResult(
        Success bool,
        Diagnostics[]BaseMemberAccessibilityBinderTests.DiagnosticInfo
    ) : IEquatable[BaseMemberAccessibilityBinderTests.CompileResult] { }

    private data struct DiagnosticInfo(Id string, Message string?) : IEquatable[
        BaseMemberAccessibilityBinderTests.DiagnosticInfo
    ] { }

    shared {
        private const FriendName string = "BaseAccess.Friend"
        private const StrangerName string = "BaseAccess.Stranger"

        private const CSharpLibrarySource string = `using System;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("BaseAccess.Friend")]

namespace BaseAccess.Library
{

public class Source
{
    private event EventHandler? PrivateChanged;
    internal event EventHandler? InternalChanged;
    protected event EventHandler? ProtectedChanged;

    public string? Label { get; internal set; }

    public string? Tag { get; private set; }

    public void Touch()
    {
        PrivateChanged?.Invoke(this, EventArgs.Empty);
    }
}

public class HidingFar
{
    public event EventHandler? Count;
    public event EventHandler? Label;

    public void Fire()
    {
        Count?.Invoke(this, EventArgs.Empty);
        Label?.Invoke(this, EventArgs.Empty);
    }
}

public class HidingMid : HidingFar
{
    public new int Count = 1;

    public new string Label { get; set; } = "a";
}

public class ReadOnlyHolder
{
    protected readonly int Fixed = 1;
}

public class StaticHolder
{
    protected static int ReadHidden { private get; set; } = 1;

    protected static int WriteHidden { get; private set; } = 2;

    protected static string? NullableWriteHidden { get; private set; }

    protected string? InstanceWriteHidden { get; private set; }

    public static string? FriendSettable { get; internal set; }
}
}

namespace BaseAccess.Named
{
    public static class @base
    {
        public static string M() => "imported base.M";
    }
}`

        private func Describe(result BaseMemberAccessibilityBinderTests.CompileResult) string -> string.Join(
            Environment.NewLine,
            result.Diagnostics.Select((d BaseMemberAccessibilityBinderTests.DiagnosticInfo) -> d.Id + ": " + d.Message)
        )

        private func CompileAgainstLibrary(body string, assemblyName string) BaseMemberAccessibilityBinderTests
            .CompileResult {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "BaseMemberAccessibilityBinderTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let libraryPath = EmitCSharpLibrary(directory, "BaseAccess.Library", CSharpLibrarySource)
                using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
                resolver.CurrentAssemblyName = assemblyName
                let compilation = GsCompilation(
                    resolver,
                    GsSyntaxTree.Parse(SourceText.From("package " + assemblyName + "\n" + body))
                ){AssemblyName = assemblyName, IsLibrary = true}
                using let output = MemoryStream()
                let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
                return BaseMemberAccessibilityBinderTests.CompileResult(
                    emit.Success,
                    emit
                        .Diagnostics
                        .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                        .Select(
                        (d GSharp.Core.CodeAnalysis.Diagnostic) -> BaseMemberAccessibilityBinderTests.DiagnosticInfo(
                            d.Id,
                            d.Message
                        )
                    )
                        .ToArray()
                )
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch (IOException) { }
            }
        }

        private func EmitCSharpLibrary(directory string, assemblyName string, source string) string {
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let path = Path.Combine(directory, assemblyName + ".dll")
            using let output = File.Create(path)
            let emit = compilation.Emit(output)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return path
        }
    }
}
