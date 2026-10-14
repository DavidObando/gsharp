// <copyright file="Issue3842QualifiedStaticAccessDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import $package
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #3842: a qualified static-member access whose type segment did not
/// resolve blamed the first namespace/package segment instead of the missing
/// type.
class Issue3842QualifiedStaticAccessDiagnosticTests {
    @Fact
    func ChainedScope_ExactPackageOutranksNearerPrefixOnlyMatch() {
        let older = BoundScope(parent: nil)
        older.RegisterSourcePackage("A.B")
        let newer = BoundScope(older)
        newer.RegisterSourcePackage("A.B.C")
        Assert.True(newer.TryMatchSourcePackagePrefix("A.B", out var exactMatch))
        Assert.True(exactMatch)
    }

    @Fact
    func SourcePackage_MissingType_ReportsLongestPackageAndMissingSegment() {
        let diagnostic = SingleError(`package A.B

func Existing() {}`, `package Consumer

func Run() {
    A.B.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal("Cannot find type 'Missing' in package 'A.B'. Are you missing an import?", diagnostic.Message)
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NamespacePrefixEndingBeforeTerminalCall_ReportsTerminalType() {
        let diagnostic = SingleError(`package A.B.Missing.Sub

func Existing() {}`, `package Consumer

func Run() {
    A.B.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal(
            "Cannot find type 'Call' in namespace 'A.B.Missing'. Are you missing an import?",
            diagnostic.Message
        )
        Assert.Equal("Call", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func ClrNamespace_MissingType_ReportsLongestNamespaceAndMissingSegment() {
        let diagnostic = SingleError(`package Consumer

func Run() {
    System.Text.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'System.Text'. Are you missing an import?",
            diagnostic.Message
        )
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func CanonicalClrNamespace_MissingType_ReportsCanonicalPrefix() {
        using let resolver = ReferenceResolver.WithReferences([]string{typeof(Existing).Assembly.Location})
        let diagnostic = SingleError(resolver, `package Consumer

func Run() {
    package_.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'package_'. Are you missing an import?",
            diagnostic.Message
        )
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func GenericMissingType_ReportsGenericIdentifier() {
        let diagnostic = SingleError(`package Consumer

func Run() {
    System.Collections.Generic.Missing[int32].Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'System.Collections.Generic'. Are you missing an import?",
            diagnostic.Message
        )
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func ResolvedGenericTypeWithInvalidArgument_DoesNotReportMissingType() {
        let diagnostic = SingleError(`package Consumer

func Run() {
    let value = System.Nullable[string].Value
}`)
        // Issue #4032: this expression's single error USED to be GS0149 "Type
        // 'Nullable' is not generic" — a last-resort fallback the qualified
        // walker reached whenever the closed construction failed for any
        // reason. It is factually wrong: `System.Nullable`1` IS generic; what
        // is wrong is the argument, because `string` does not satisfy the
        // declared `struct` constraint. gsc now validates declared constraints
        // at every construction site (`Type.MakeGenericType` does not do it
        // under MetadataLoadContext), so the accurate diagnostic is available
        // and the fallback is suppressed when the failure was already
        // explained.
        //
        // The test's stated intent is unchanged and still enforced: exactly ONE
        // error (`SingleError`), and it is not the "cannot find type"
        // GS0157 this fixture exists to rule out.
        Assert.Equal("GS0152", diagnostic.Id)
        Assert.Equal(
            "Type argument 'string' for type parameter 'T' does not satisfy the 'struct' constraint.",
            diagnostic.Message
        )
        Assert.Equal("Nullable[string]", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NonGenericQualifiedTypeWithTypeArguments_ReportsTypeNotGeneric() {
        let diagnostic = SingleError(`package Consumer

func Run() {
    let value = System.String[int32].Empty
}`)
        Assert.Equal("GS0149", diagnostic.Id)
        Assert.Equal("Type 'String' is not generic.", diagnostic.Message)
        Assert.Equal("String", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NonTypeGenericArgument_StillReportsAnError() {
        let diagnostic = SingleError(`package Consumer

func Run() {
    let value = System.Collections.Generic.List[1].Count
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal("Cannot find type 1. Are you missing an import?", diagnostic.Message)
        Assert.Equal("1", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func AliasOnlySourcePackage_IsRecognized() {
        let diagnostic = SingleError(`package A.B

type Existing = int32`, `package Consumer

func Run() {
    A.B.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal("Cannot find type 'Missing' in package 'A.B'. Are you missing an import?", diagnostic.Message)
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func UnrelatedSourceAlias_DoesNotHideQualifiedMissingType() {
        let diagnostic = SingleError(`package A.B

func Existing() {}`, `package C

type Missing = int32`, `package Consumer
import C

func Run() {
    A.B.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal("Cannot find type 'Missing' in package 'A.B'. Are you missing an import?", diagnostic.Message)
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func UnresolvedImport_DoesNotPretendItsTargetIsAPackage() {
        let diagnostic = SingleError(`package Consumer
import Foo.Bar

func Run() {
    Foo.Bar.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal("Cannot find type Foo. Are you missing an import?", diagnostic.Message)
        Assert.Equal("Foo", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func ImplicitDefaultPackage_IsNotQualifiedByItsSynthesizedName() {
        using let references = ReferenceResolver.WithReferences([]string{typeof(object).Assembly.Location})
        Assert.Equal(typeof(object).Assembly.GetName().Name, Assert.Single(references.Assemblies).GetName().Name)
        let diagnostic = SingleError(references, `class Present {}

func Run() {
    Default.Missing.Call()
}`)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal("Cannot find type Default. Are you missing an import?", diagnostic.Message)
        Assert.Equal("Default", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func ExplicitDefaultPackage_IsRecognizedRegardlessOfTreeOrder(implicitTreeFirst bool) {
        const implicitSource = "class Present {}"
        const explicitSource = `package Default

func Existing() {}`
        const consumer = `package Consumer

func Run() {
    Default.Missing.Call()
}`
        let sources = if implicitTreeFirst {
            []string{implicitSource, explicitSource, consumer}
        } else {
            []string{explicitSource, implicitSource, consumer}
        }
        let diagnostic = SingleError(sources)
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal("Cannot find type 'Missing' in package 'Default'. Are you missing an import?", diagnostic.Message)
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func PackageNameCollidingWithSourceType_DoesNotPreemptNestedTypeBinding() {
        let diagnostics = Errors(`package Outer

func PackageMarker() {}`, `package Consumer

class Outer {
    class Inner {
        shared {
            func Member() int32 -> 1
        }
    }
}

func Run() int32 -> Outer.Inner.Member()`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func PackageNameCollidingWithSourceType_DoesNotPreemptStaticMemberBinding() {
        let diagnostics = Errors(`package Outer

func PackageMarker() {}`, `package Consumer

class Outer {
    shared {
        prop Value string -> "x"
    }
}

func Run() int32 -> Outer.Value.Length`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func NamespaceNameCollidingWithOutOfRegionPatternVariable_ReportsDefiniteAssignment() {
        let diagnostic = SingleError(`package Consumer

func Run(value object) {
    if value is string System {}
    System.Text.Missing.Call()
}`)
        Assert.Equal("GS0532", diagnostic.Id)
        Assert.Contains("not definitely assigned here", diagnostic.Message, StringComparison.Ordinal)
        Assert.Equal("System", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NamespaceNameCollidingWithDefaultInterfaceProperty_DoesNotPreemptReceiverBinding() {
        let diagnostics = Errors(`package Consumer

class Holder {
    prop Text string -> "value"
}

interface IConsumer {
    prop System Holder { get; }

    func Run() int32 {
        return System.Text.Length
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SourceType_MissingStaticMember_StillReportsMember() {
        let diagnostic = SingleError(`package A.B

class Present {}`, `package Consumer

func Run() {
    A.B.Present.Missing()
}`)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Cannot find member Missing.", diagnostic.Message)
        Assert.Equal("Missing()", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func ClrType_MissingStaticMember_StillReportsMember() {
        let diagnostic = SingleError(`package Consumer

func Run() {
    System.Text.StringBuilder.Missing()
}`)
        Assert.Equal("GS0159", diagnostic.Id)
        Assert.Equal("Cannot find function Missing.", diagnostic.Message)
        Assert.Equal("Missing()", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    shared {
        private func SingleError(sources ...string) Diagnostic -> Assert.Single(Errors(sources))

        private func SingleError(resolver ReferenceResolver, sources ...string) Diagnostic -> Assert.Single(
            Errors(resolver, sources)
        )

        private func Errors(sources ...string)[]Diagnostic -> Errors(references: nil, sources)

        private func Errors(references ReferenceResolver?, sources ...string)[]Diagnostic {
            let trees = sources.Select((source string) -> SyntaxTree.Parse(SourceText.From(source))).ToArray()
            let compilation = Compilation(references, trees){IsLibrary = true}
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToArray()
        }
    }
}
