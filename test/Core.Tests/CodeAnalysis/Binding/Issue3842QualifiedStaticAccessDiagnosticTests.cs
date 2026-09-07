// <copyright file="Issue3842QualifiedStaticAccessDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3842: a qualified static-member access whose type segment did not
/// resolve blamed the first namespace/package segment instead of the missing
/// type.
/// </summary>
public sealed class Issue3842QualifiedStaticAccessDiagnosticTests
{
    [Fact]
    public void ChainedScope_ExactPackageOutranksNearerPrefixOnlyMatch()
    {
        var older = new BoundScope(parent: null);
        older.RegisterSourcePackage("A.B");
        var newer = new BoundScope(older);
        newer.RegisterSourcePackage("A.B.C");

        Assert.True(newer.TryMatchSourcePackagePrefix("A.B", out var exactMatch));
        Assert.True(exactMatch);
    }

    [Fact]
    public void SourcePackage_MissingType_ReportsLongestPackageAndMissingSegment()
    {
        var diagnostic = SingleError(
            """
            package A.B

            func Existing() {}
            """,
            """
            package Consumer

            func Run() {
                A.B.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in package 'A.B'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void NamespacePrefixEndingBeforeTerminalCall_ReportsTerminalType()
    {
        var diagnostic = SingleError(
            """
            package A.B.Missing.Sub

            func Existing() {}
            """,
            """
            package Consumer

            func Run() {
                A.B.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Call' in namespace 'A.B.Missing'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Call", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void ClrNamespace_MissingType_ReportsLongestNamespaceAndMissingSegment()
    {
        var diagnostic = SingleError(
            """
            package Consumer

            func Run() {
                System.Text.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'System.Text'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void CanonicalClrNamespace_MissingType_ReportsCanonicalPrefix()
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(global::@package.Existing).Assembly.Location });
        var diagnostic = SingleError(
            resolver,
            """
            package Consumer

            func Run() {
                package_.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'package_'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void GenericMissingType_ReportsGenericIdentifier()
    {
        var diagnostic = SingleError(
            """
            package Consumer

            func Run() {
                System.Collections.Generic.Missing[int32].Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'System.Collections.Generic'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void ResolvedGenericTypeWithInvalidArgument_DoesNotReportMissingType()
    {
        var diagnostic = SingleError(
            """
            package Consumer

            func Run() {
                let value = System.Nullable[string].Value
            }
            """);

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
        Assert.Equal("GS0152", diagnostic.Id);
        Assert.Equal(
            "Type argument 'string' for type parameter 'T' does not satisfy the 'struct' constraint.",
            diagnostic.Message);
        Assert.Equal("Nullable[string]", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void NonGenericQualifiedTypeWithTypeArguments_ReportsTypeNotGeneric()
    {
        var diagnostic = SingleError(
            """
            package Consumer

            func Run() {
                let value = System.String[int32].Empty
            }
            """);

        Assert.Equal("GS0149", diagnostic.Id);
        Assert.Equal("Type 'String' is not generic.", diagnostic.Message);
        Assert.Equal("String", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void NonTypeGenericArgument_StillReportsAnError()
    {
        var diagnostic = SingleError(
            """
            package Consumer

            func Run() {
                let value = System.Collections.Generic.List[1].Count
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal("Cannot find type 1. Are you missing an import?", diagnostic.Message);
        Assert.Equal("1", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void AliasOnlySourcePackage_IsRecognized()
    {
        var diagnostic = SingleError(
            """
            package A.B

            type Existing = int32
            """,
            """
            package Consumer

            func Run() {
                A.B.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in package 'A.B'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void UnrelatedSourceAlias_DoesNotHideQualifiedMissingType()
    {
        var diagnostic = SingleError(
            """
            package A.B

            func Existing() {}
            """,
            """
            package C

            type Missing = int32
            """,
            """
            package Consumer
            import C

            func Run() {
                A.B.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in package 'A.B'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void UnresolvedImport_DoesNotPretendItsTargetIsAPackage()
    {
        var diagnostic = SingleError(
            """
            package Consumer
            import Foo.Bar

            func Run() {
                Foo.Bar.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal("Cannot find type Foo. Are you missing an import?", diagnostic.Message);
        Assert.Equal("Foo", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void ImplicitDefaultPackage_IsNotQualifiedByItsSynthesizedName()
    {
        var diagnostic = SingleError(
            """
            class Present {}

            func Run() {
                Default.Missing.Call()
            }
            """);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal("Cannot find type Default. Are you missing an import?", diagnostic.Message);
        Assert.Equal("Default", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ExplicitDefaultPackage_IsRecognizedRegardlessOfTreeOrder(bool implicitTreeFirst)
    {
        const string implicitSource = "class Present {}";
        const string explicitSource = """
            package Default

            func Existing() {}
            """;
        const string consumer = """
            package Consumer

            func Run() {
                Default.Missing.Call()
            }
            """;

        var sources = implicitTreeFirst
            ? new[] { implicitSource, explicitSource, consumer }
            : new[] { explicitSource, implicitSource, consumer };
        var diagnostic = SingleError(sources);

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in package 'Default'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void PackageNameCollidingWithSourceType_DoesNotPreemptNestedTypeBinding()
    {
        var diagnostics = Errors(
            """
            package Outer

            func PackageMarker() {}
            """,
            """
            package Consumer

            class Outer {
                class Inner {
                    shared {
                        func Member() int32 -> 1
                    }
                }
            }

            func Run() int32 -> Outer.Inner.Member()
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PackageNameCollidingWithSourceType_DoesNotPreemptStaticMemberBinding()
    {
        var diagnostics = Errors(
            """
            package Outer

            func PackageMarker() {}
            """,
            """
            package Consumer

            class Outer {
                shared {
                    prop Value string -> "x"
                }
            }

            func Run() int32 -> Outer.Value.Length
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NamespaceNameCollidingWithOutOfRegionPatternVariable_ReportsDefiniteAssignment()
    {
        var diagnostic = SingleError(
            """
            package Consumer

            func Run(value object) {
                if value is string System {}
                System.Text.Missing.Call()
            }
            """);

        Assert.Equal("GS0532", diagnostic.Id);
        Assert.Contains("not definitely assigned here", diagnostic.Message, System.StringComparison.Ordinal);
        Assert.Equal("System", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void NamespaceNameCollidingWithDefaultInterfaceProperty_DoesNotPreemptReceiverBinding()
    {
        var diagnostics = Errors(
            """
            package Consumer

            class Holder {
                prop Text string -> "value"
            }

            interface IConsumer {
                prop System Holder { get; }

                func Run() int32 {
                    return System.Text.Length
                }
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SourceType_MissingStaticMember_StillReportsMember()
    {
        var diagnostic = SingleError(
            """
            package A.B

            class Present {}
            """,
            """
            package Consumer

            func Run() {
                A.B.Present.Missing()
            }
            """);

        Assert.Equal("GS0158", diagnostic.Id);
        Assert.Equal("Cannot find member Missing.", diagnostic.Message);
        Assert.Equal("Missing()", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void ClrType_MissingStaticMember_StillReportsMember()
    {
        var diagnostic = SingleError(
            """
            package Consumer

            func Run() {
                System.Text.StringBuilder.Missing()
            }
            """);

        Assert.Equal("GS0159", diagnostic.Id);
        Assert.Equal("Cannot find function Missing.", diagnostic.Message);
        Assert.Equal("Missing()", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    private static Diagnostic SingleError(params string[] sources)
        => Assert.Single(Errors(sources));

    private static Diagnostic SingleError(ReferenceResolver resolver, params string[] sources)
        => Assert.Single(Errors(resolver, sources));

    private static Diagnostic[] Errors(params string[] sources)
        => Errors(references: null, sources);

    private static Diagnostic[] Errors(ReferenceResolver references, params string[] sources)
    {
        var trees = sources.Select(source => SyntaxTree.Parse(SourceText.From(source))).ToArray();
        var compilation = new Compilation(references, trees) { IsLibrary = true };
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();
    }
}
