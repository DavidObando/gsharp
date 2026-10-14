// <copyright file="Issue1239CoalesceCommonTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #1239: the null-coalescing operator `a ?? b` must compute the
/// C# §12.15 best common type rather than requiring both operands to share an
/// exact type. When the left's non-null type implicitly converts to the right
/// operand's type (a reference upcast / interface implementation or a numeric
/// widening) — or vice versa — `??` binds cleanly instead of reporting
/// GS0129.
open class Issue1239CoalesceCommonTypeTests {
    @Fact
    func RightImplementsInterface_BindsToInterface() {
        const Source = `package Issue1239.Iface

interface IFoo { func Bar() int32; }
class Foo : IFoo { func Bar() int32 { return 1 } }
class C {
    func ToIface(f Foo?, g IFoo) IFoo { return f ?? g }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func RightSubtypeConvertsToNullableLeftInterface() {
        const Source = `package Issue2540.Iface

interface ILogger { func Name() string; }
class NullLogger : ILogger { func Name() string { return "null" } }
class C {
    func Pick(logger ILogger?) ILogger { return logger ?? NullLogger() }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func NullableRightSubtypeConvertsToNullableLeftInterface() {
        const Source = `package Issue2540.NullableIface

interface ILogger { }
class NullLogger : ILogger { }
class C {
    func Pick(logger ILogger?, fallback NullLogger?) ILogger? {
        var selected = logger ?? fallback
        return selected
    }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func NullableUnrelatedTypesStillReportError() {
        const Source = `package Issue2540.InvalidNullable

interface ILogger { }
class Other { }
class C {
    func Bad(logger ILogger?, fallback Other?) ILogger? {
        var selected = logger ?? fallback
        return selected
    }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func NullabilityAnnotatedNullableInterface_UsesUnderlyingConversion() {
        let contract = InterfaceSymbol("ILogger", Accessibility.Public, declaration: nil, packageName: "Issue2540")
        let implementation = StructSymbol(
            "NullLogger",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: "Issue2540",
            isData: false,
            isInline: false,
            isClass: true
        )
        implementation.SetInterfaces(ImmutableArray.Create(contract))
        let annotatedContract = NullabilityAnnotatedTypeSymbol(
            contract,
            ImmutableArray.Create[uint8](uint8(1), uint8(1))
        )
        let op BoundBinaryOperator? = BoundBinaryOperator.Bind(
            SyntaxKind.QuestionQuestionToken,
            NullableTypeSymbol.Get(annotatedContract),
            implementation
        )
        Assert.NotNull(op)
        Assert.Same(annotatedContract, op!!.Type)
    }

    @Fact
    func NullabilityAnnotatedNullableInterface_PreservesUnrelatedNegative() {
        let contract = InterfaceSymbol("ILogger", Accessibility.Public, declaration: nil, packageName: "Issue2540")
        let other = StructSymbol(
            "Other",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: "Issue2540",
            isData: false,
            isInline: false,
            isClass: true
        )
        let annotatedContract = NullabilityAnnotatedTypeSymbol(
            contract,
            ImmutableArray.Create[uint8](uint8(1), uint8(1))
        )
        let op BoundBinaryOperator? = BoundBinaryOperator.Bind(
            SyntaxKind.QuestionQuestionToken,
            NullableTypeSymbol.Get(annotatedContract),
            other
        )
        Assert.Null(op)
    }

    @Fact
    func ImportedRightSubtypeConvertsToNullableLeftInterface() {
        const Source = `package Issue2540.ImportedIface

import System
import System.IO

class C {
    func Pick(resource IDisposable?) IDisposable { return resource ?? MemoryStream() }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func RightDelegateFactoryConvertsToNullableLeftDelegate() {
        const Source = `package Issue2540.Delegate

interface ILogger { func Name() string; }
class NullLogger : ILogger { func Name() string { return "null" } }
class C {
    func Pick(factory (() -> ILogger)?) () -> ILogger {
        return factory ?? (() -> NullLogger())
    }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func UnrelatedDelegateFactoryReturnStillReportsError() {
        const Source = `package Issue2540.InvalidDelegate

interface ILogger { }
class Other { }
class C {
    func Bad(factory (() -> ILogger)?) () -> ILogger {
        return factory ?? (() -> Other())
    }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func ExplicitTargetType_BindsToInterface() {
        const Source = `package Issue1239.Target

interface IFoo { func Bar() int32; }
class Foo : IFoo { func Bar() int32 { return 1 } }
class C {
    func WithTarget(f Foo?, g IFoo) IFoo {
        let r IFoo = f ?? g
        return r
    }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func RightIsBaseClass_BindsToBaseClass() {
        const Source = `package Issue1239.BaseClass

open class Animal { func Speak() int32 { return 10 } }
class Dog : Animal { }
class C {
    func Pick(d Dog?, a Animal) Animal { return d ?? a }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func NumericWidening_RightWidensToLeft_BindsToLeftType() {
        const Source = `package Issue1239.NumWiden

class C {
    func Coalesce(a int32?, b uint16) int32 { return a ?? b }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func NumericWidening_LeftWidensToRight_BindsToRightType() {
        const Source = `package Issue1239.NumWiden2

class C {
    func Coalesce(a int32?, b int64) int64 { return a ?? b }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.Empty(diagnostics)
    }

    @Fact
    func SameType_StillBinds() {
        const Source = `package Issue1239.Same

class Foo { func Bar() int32 { return 1 } }
class C {
    func Same(f Foo?, g Foo) Foo { return f ?? g }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Unrelated_TypesStillReportError() {
        // Regression guard: when no implicit conversion exists in either
        // direction, `??` still reports GS0129.
        const Source = `package Issue1239.Unrelated

class Foo { }
class Bar { }
class C {
    func Bad(f Foo?, g Bar) Foo { return f ?? g }
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    shared {
        private func EmitDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
