// <copyright file="EventSubscriptionAccessibilityBinderTests.cs" company="GSharp">
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
import System.Reflection
import System.Reflection.Emit

/// Issue #4394: every event-subscription path checks that the subscribing
/// code can reach the event, as `base.E += h` has since #4380. C#
/// reports CS0122 for these; gsc reports its usual inaccessible-member
/// diagnostics (GS0472 for `private`, GS0379 for `protected`).
/// - source events: `obj.E += h`, `-=`, a bare `E += h` in a derived class, and a class-constrained
/// type parameter receiver;
/// - imported events: an event that exists but is not reachable is reported as inaccessible rather than
/// "cannot find member" (GS0158); a `protected` one is reachable from a derived class through its own
/// instance.
/// The reachable cells are compiled, verified and run in Compiler.Tests'
/// `EventAndBaseMethodGroupEmitTests`.
class EventSubscriptionAccessibilityBinderTests {
    @Theory
    @InlineData("s.Priv += h", "GS0472", "Priv")
    @InlineData("s.Priv -= h", "GS0472", "Priv")
    @InlineData("s.Prot += h", "GS0379", "Prot")
    @InlineData("s.Prot -= h", "GS0379", "Prot")
    func SourceEvent_FromUnrelatedClass_IsReportedInaccessible(statement string, id string, eventName string) {
        let source = SourceDeclarations + (`class Other {
    func Hook(s Source, h EventHandler) {
        ` + "$statement" + `
    }
}`)
        AssertSingleError(source, id, eventName)
    }

    @Theory
    @InlineData("Priv += h")
    @InlineData("this.Priv += h")
    @InlineData("this.Priv -= h")
    @InlineData("other.Priv += h")
    func PrivateSourceEvent_FromDerivedClass_IsReportedInaccessible(statement string) {
        let source = SourceDeclarations + (`class Derived : Source {
    func Hook(other Derived, h EventHandler) {
        ` + "$statement" + `
    }
}`)
        AssertSingleError(source, "GS0472", "Priv")
    }

    @Fact
    func PrivateSourceEvent_ThroughClassConstrainedTypeParameter_IsReportedInaccessible() {
        let source = SourceDeclarations + `class Other {
    func Hook[T Source](t T, h EventHandler) {
        t.Priv += h
    }
}`
        AssertSingleError(source, "GS0472", "Priv")
    }

    @Fact
    func ReachableSourceEvents_Bind() {
        let source = SourceDeclarations + `open class Declaring {
    private event Own EventHandler?
    func Hook(other Declaring, h EventHandler) {
        other.Own += h
        Own += h
        this.Own -= h
    }
}

class Derived : Source {
    func Hook(other Derived, h EventHandler) {
        Prot += h
        this.Prot += h
        other.Prot -= h
        this.Intl += h
    }
}

class Other {
    func Hook(s Source, h EventHandler) {
        s.Intl += h
        s.Pub += h
        s.Pub -= h
    }
}`
        let errors = EmittedOracle
            .Evaluate(source)
            .Diagnostics
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToArray()
        Assert.Empty(errors)
    }

    @Theory
    @InlineData("s.Priv += h", "GS0472", "Priv")
    @InlineData("s.Priv -= h", "GS0472", "Priv")
    @InlineData("s.Prot += h", "GS0379", "Prot")
    @InlineData("s.ProtIntl += h", "GS0379", "ProtIntl")
    @InlineData("s.Intl += h", "GS0472", "Intl")
    @InlineData("s.PrivProt += h", "GS0472", "PrivProt")
    func ImportedEvent_FromUnrelatedClass_IsReportedInaccessible(statement string, id string, eventName string) {
        let result = CompileAgainstLibrary((`import System
import EventAccess.Library

class Other {
    func Hook(s CSource, h EventHandler) {
        ` + "$statement" + `
    }
}`))
        Assert.False(result.Success)
        let error = Assert.Single(result.Diagnostics)
        Assert.Equal(id, error.Id)
        Assert.Contains(eventName, error.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("this.Priv += h", "GS0472")
    @InlineData("other.Priv -= h", "GS0472")
    @InlineData("this.PrivProt += h", "GS0472")
    @InlineData("s.Prot += h", "GS0379")
    func ImportedEvent_FromDerivedClass_UnreachableCell_IsReportedInaccessible(statement string, id string) {
        // A derived class reaches a protected event only through an instance
        // of its own class (C#'s rule for protected instance access); a
        // `CSource`-typed receiver may be some other subclass.
        let result = CompileAgainstLibrary((`import System
import EventAccess.Library

class Der : CSource {
    func Hook(other Der, s CSource, h EventHandler) {
        ` + "$statement" + `
    }
}`))
        Assert.False(result.Success)
        let error = Assert.Single(result.Diagnostics)
        Assert.Equal(id, error.Id)
    }

    @Fact
    func ImportedEvent_ReachableCells_Bind() {
        let result = CompileAgainstLibrary(`import System
import EventAccess.Library

class Der : CSource {
    func Hook(other Der, h EventHandler) {
        this.Prot += h
        this.Prot -= h
        other.Prot += h
        this.ProtIntl += h
        this.Pub += h
    }
}

class Other {
    func Hook(s CSource, h EventHandler) {
        s.Pub += h
        s.Pub -= h
        s.Split += h
        s.Split -= h
    }
}`)
        Assert.True(result.Success, Describe(result))
    }

    @Theory
    @InlineData("this.AddPublic += h")
    @InlineData("this.AddPublic -= h")
    @InlineData("this.RemovePublic += h")
    @InlineData("this.RemovePublic -= h")
    func SplitAccessorImportedEvent_FromDerivedClass_EachAccessorBinds(statement string) {
        // Each accessor is public or protected, and the derived class may
        // call a protected one through its own instance: all four bind,
        // whichever accessor the visible-member probe found the event by.
        let result = CompileAgainstLibrary((`import System
import EventAccess.Split

class Der : Source {
    func Hook(h EventHandler) {
        ` + "$statement" + `
    }
}`), EmitSplitAccessorLibrary)
        Assert.True(result.Success, Describe(result))
    }

    @Theory
    @InlineData("s.AddPublic += h", true)
    @InlineData("s.AddPublic -= h", false)
    @InlineData("s.RemovePublic += h", false)
    @InlineData("s.RemovePublic -= h", true)
    func SplitAccessorImportedEvent_FromUnrelatedClass_ChecksTheCalledAccessor(statement string, binds bool) {
        // An unrelated class can call only the public accessor, so
        // `+=` and `-=` on one event can differ.
        let result = CompileAgainstLibrary((`import System
import EventAccess.Split

class Other {
    func Hook(s Source, h EventHandler) {
        ` + "$statement" + `
    }
}`), EmitSplitAccessorLibrary)
        if binds {
            Assert.True(result.Success, Describe(result))
        } else {
            let error = Assert.Single(result.Diagnostics)
            Assert.Equal("GS0379", error.Id)
        }
    }

    @Fact
    func MissingImportedEvent_StillReportsCannotFindMember() {
        let result = CompileAgainstLibrary(`import System
import EventAccess.Library

class Other {
    func Hook(s CSource, h EventHandler) {
        s.Nope += h
    }
}`)
        Assert.False(result.Success)
        let error = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", error.Id)
    }

    private data struct CompileResult(
        Success bool,
        Diagnostics[]EventSubscriptionAccessibilityBinderTests.DiagnosticInfo
    ) : IEquatable[EventSubscriptionAccessibilityBinderTests.CompileResult] { }

    private data struct DiagnosticInfo(Id string, Message string?) : IEquatable[
        EventSubscriptionAccessibilityBinderTests.DiagnosticInfo
    ] { }

    shared {
        private const AssemblyName string = "EventAccess.Consumer"

        private const SourceDeclarations string = `import System

open class Source {
    private event Priv EventHandler?
    protected event Prot EventHandler?
    internal event Intl EventHandler?
    event Pub EventHandler?
}
`

        private const CSharpLibrarySource string = `using System;

namespace EventAccess.Library
{
    public class CSource
    {
        private event EventHandler? Priv;
        protected event EventHandler? Prot;
        internal event EventHandler? Intl;
        public event EventHandler? Pub;
        protected internal event EventHandler? ProtIntl;
        private protected event EventHandler? PrivProt;

        public event EventHandler? Split
        {
            add { }
            remove { }
        }

        public void Fire()
        {
            Priv?.Invoke(this, EventArgs.Empty);
            Prot?.Invoke(this, EventArgs.Empty);
            Intl?.Invoke(this, EventArgs.Empty);
            Pub?.Invoke(this, EventArgs.Empty);
            ProtIntl?.Invoke(this, EventArgs.Empty);
            PrivProt?.Invoke(this, EventArgs.Empty);
        }
    }
}`

        private func AssertSingleError(source string, id string, eventName string) {
            let errors = EmittedOracle
                .Evaluate(source)
                .Diagnostics
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .ToArray()
            let error = Assert.Single(errors)
            Assert.Equal(id, error.Id)
            Assert.Contains(eventName, error.Message, StringComparison.Ordinal)
        }

        private func Describe(result EventSubscriptionAccessibilityBinderTests.CompileResult) string -> string.Join(
            Environment.NewLine,
            result.Diagnostics.Select(
                (d EventSubscriptionAccessibilityBinderTests.DiagnosticInfo) -> d.Id + ": " + d.Message
            )
        )

        private func CompileAgainstLibrary(
            body string,
            emitLibrary((string) -> string)? = nil
        ) EventSubscriptionAccessibilityBinderTests
            .CompileResult {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "EventSubscriptionAccessibilityBinderTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let libraryPath = if emitLibrary != nil {
                    emitLibrary(directory)
                } else {
                    EmitCSharpLibrary(directory, "EventAccess.Library", CSharpLibrarySource)
                }
                using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
                resolver.CurrentAssemblyName = EventSubscriptionAccessibilityBinderTests.AssemblyName
                let compilation = GsCompilation(
                    resolver,
                    GsSyntaxTree.Parse(
                        SourceText.From(
                            "package " + EventSubscriptionAccessibilityBinderTests.AssemblyName + "\n" + body
                        )
                    )
                ){AssemblyName = EventSubscriptionAccessibilityBinderTests.AssemblyName, IsLibrary = true}
                using let output = MemoryStream()
                let emit = compilation.Emit(
                    output,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: EventSubscriptionAccessibilityBinderTests.AssemblyName
                )
                return EventSubscriptionAccessibilityBinderTests.CompileResult(
                    emit.Success,
                    emit
                        .Diagnostics
                        .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                        .Select(
                        (
                            d GSharp.Core.CodeAnalysis.Diagnostic
                        ) -> EventSubscriptionAccessibilityBinderTests.DiagnosticInfo(d.Id, d.Message)
                    )
                        .ToArray()
                )
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException {
                    // Best-effort cleanup: a handle released late must not fail the test.

                }
            }
        }

        /// Emits `EventAccess.Split.Source`, whose events give their two
        /// accessors different accessibilities, which C# cannot declare but
        /// metadata can: `AddPublic` has a public add and a protected
        /// remove, `RemovePublic` a protected add and a public remove.
        private func EmitSplitAccessorLibrary(directory string) string {
            const name = "EventAccess.Split"
            let assembly = PersistedAssemblyBuilder(AssemblyName(name), typeof(object).Assembly)
            let module = assembly.DefineDynamicModule(name)
            let type = module.DefineType("EventAccess.Split.Source", TypeAttributes.Public | TypeAttributes.Class)
            type.DefineDefaultConstructor(MethodAttributes.Public)
            let DefineEvent = func (eventName string, addAccess MethodAttributes, removeAccess MethodAttributes) {
                let ev = type.DefineEvent(eventName, EventAttributes.None, typeof(EventHandler))
                let Accessor = func (accessorName string, access MethodAttributes) MethodBuilder {
                    let method = type.DefineMethod(
                        accessorName,
                        access | MethodAttributes.SpecialName | MethodAttributes.HideBySig,
                        typeof(Void),
                        []Type{typeof(EventHandler)}
                    )
                    method.GetILGenerator().Emit(OpCodes.Ret)
                    return method
                }
                ev.SetAddOnMethod(Accessor("add_" + eventName, addAccess))
                ev.SetRemoveOnMethod(Accessor("remove_" + eventName, removeAccess))
            }
            DefineEvent("AddPublic", MethodAttributes.Public, MethodAttributes.Family)
            DefineEvent("RemovePublic", MethodAttributes.Family, MethodAttributes.Public)
            type.CreateType()
            let path = Path.Combine(directory, name + ".dll")
            assembly.Save(path)
            return path
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
