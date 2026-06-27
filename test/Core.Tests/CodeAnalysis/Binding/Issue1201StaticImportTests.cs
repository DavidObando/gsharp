// <copyright file="Issue1201StaticImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1201 / ADR-0134: a non-alias type import (<c>import Ns.Type</c>, the
/// G# spelling of C#'s <c>using static</c>) brings that type's <c>shared</c>
/// (static) members into scope for <em>unqualified</em> reference. These tests
/// pin the binder behaviour: unqualified calls and identifiers resolve to the
/// imported type's shared methods, generic shared methods, static fields/consts,
/// and static properties; a plain namespace import and an alias import do NOT
/// hoist members; and an unqualified name exposed by two imported types is an
/// ambiguity error (GS0414).
/// </summary>
public class Issue1201StaticImportTests
{
    [Fact]
    public void TypeImport_ExposesSharedMethod_ForUnqualifiedCall()
    {
        // The exact repro from the issue: `import p.aux.EnumUtil` lets the
        // caller invoke the shared `GetValues()` without the `EnumUtil.` prefix.
        var util = """
            package p.aux
            class EnumUtil {
                shared {
                    func GetValues() []int32 { return []int32{1, 2, 3} }
                }
            }
            """;
        var caller = """
            package p.main
            import p.aux.EnumUtil
            class C {
                func F() []int32 {
                    return GetValues()
                }
            }
            """;

        Assert.Empty(Bind(util, caller));
    }

    [Fact]
    public void TypeImport_ExposesGenericSharedMethod_ForUnqualifiedCall()
    {
        // The Oahu impact: a generic shared method called unqualified with an
        // explicit type argument (`GetValues[int32]()`) must resolve through the
        // static import exactly as the qualified `EnumUtil.GetValues[int32]()`.
        var util = """
            package p.aux
            class EnumUtil {
                shared {
                    func GetValues[T any]() []T { return []T{} }
                }
            }
            """;
        var caller = """
            package p.main
            import p.aux.EnumUtil
            class C {
                func F() []int32 {
                    return GetValues[int32]()
                }
            }
            """;

        Assert.Empty(Bind(util, caller));
    }

    [Fact]
    public void TypeImport_ExposesStaticFieldConstAndProperty_ForUnqualifiedRead()
    {
        var util = """
            package p.aux
            class Config {
                shared {
                    const Answer int32 = 42
                    let Greeting string = "hi"
                    prop Level int32 { get { return 7 } }
                }
            }
            """;
        var caller = """
            package p.main
            import p.aux.Config
            class C {
                func A() int32 { return Answer }
                func B() string { return Greeting }
                func D() int32 { return Level }
            }
            """;

        Assert.Empty(Bind(util, caller));
    }

    [Fact]
    public void NamespaceImport_DoesNotExposeSharedMembers()
    {
        // A plain namespace import (`import p.aux`) names no type, so the bare
        // call stays unresolved — GS0130 — matching C#, where `using p.aux`
        // (not `using static`) does not hoist members.
        var util = """
            package p.aux
            class EnumUtil {
                shared {
                    func GetValues() []int32 { return []int32{1, 2, 3} }
                }
            }
            """;
        var caller = """
            package p.main
            import p.aux
            class C {
                func F() []int32 {
                    return GetValues()
                }
            }
            """;

        Assert.Contains(Bind(util, caller), d => d.Id == "GS0130");
    }

    [Fact]
    public void AliasImport_DoesNotExposeSharedMembers()
    {
        // `import eu = p.aux.EnumUtil` is a type alias, not a static import, so
        // the bare call stays unresolved (mirroring C#, where `using X = T;`
        // does not hoist members). The alias is still usable qualified.
        var util = """
            package p.aux
            class EnumUtil {
                shared {
                    func GetValues() []int32 { return []int32{1, 2, 3} }
                }
            }
            """;
        var caller = """
            package p.main
            import eu = p.aux.EnumUtil
            class C {
                func F() []int32 {
                    return GetValues()
                }
            }
            """;

        Assert.Contains(Bind(util, caller), d => d.Id == "GS0130");
    }

    [Fact]
    public void AmbiguousSharedMember_AcrossTwoTypeImports_ReportsGS0414()
    {
        var util = """
            package p.aux
            class A {
                shared { func Shared() int32 { return 1 } }
            }
            class B {
                shared { func Shared() int32 { return 2 } }
            }
            """;
        var caller = """
            package p.main
            import p.aux.A
            import p.aux.B
            class C {
                func F() int32 {
                    return Shared()
                }
            }
            """;

        Assert.Contains(Bind(util, caller), d => d.Id == "GS0414");
    }

    [Fact]
    public void AmbiguousSharedMember_QualifyingDisambiguates()
    {
        // The same two imports are fine when the references are qualified: the
        // ambiguity is only reported when the bare name is actually used.
        var util = """
            package p.aux
            class A {
                shared { func Shared() int32 { return 1 } }
            }
            class B {
                shared { func Shared() int32 { return 2 } }
            }
            """;
        var caller = """
            package p.main
            import p.aux.A
            import p.aux.B
            class C {
                func F() int32 {
                    return A.Shared() + B.Shared()
                }
            }
            """;

        Assert.Empty(Bind(util, caller));
    }

    private static ImmutableArray<Diagnostic> Bind(params string[] sources)
    {
        var trees = sources.Select(s => SyntaxTree.Parse(SourceText.From(s))).ToImmutableArray();
        var parseDiagnostics = trees.SelectMany(t => t.Diagnostics).ToImmutableArray();
        if (parseDiagnostics.Any())
        {
            return parseDiagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, trees);
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
