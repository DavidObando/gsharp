// <copyright file="Issue3887ErrorTypedReceiverCascadeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3887 (the #3842 / #3880 / #3886 / #3907 family): a member lookup on a
/// receiver whose type is ALREADY <c>TypeSymbol.Error</c> used to report a NEW
/// independent <c>GS0158 Cannot find member</c> / <c>GS0159 Cannot find
/// function</c>. Those reports are provably redundant — the receiver is only
/// error-typed because some earlier expression was already diagnosed — and they
/// are actively misdirecting: they name members that demonstrably exist, on
/// types the user never wrote, at lines whose fix is elsewhere.
/// <para>
/// The tax is measurable. On the migrated <c>test/Compiler.Tests</c> wall
/// (#3886) a single GS0154 produced sixteen cascade "Cannot find" errors whose
/// names (<c>GetType</c>, <c>GetMethod</c>, <c>GetProperties</c>,
/// <c>MetadataToken</c>, <c>Invoke</c>) made the wall read as a
/// <c>System.Reflection</c> member-resolution failure that does not exist.
/// </para>
/// <para>
/// The fix marks — it does not skip — those two diagnostics when the receiver
/// of <c>ExpressionBinder.BindAccessorStep</c> is error-typed, and filters them
/// when the bag is READ. <c>BindAccessorStep</c> is the single chokepoint every
/// member access, method call, index and null-conditional step routes through.
/// Suppression must change which diagnostics are emitted and never what binds;
/// <see cref="Suppression_DoesNotChangeEmittedIl"/> pins that invariant, and
/// the two designs that violated it are recorded there. Lookups on genuinely
/// well-typed receivers are untouched; the anti-vacuity tests below pass on
/// origin/main and must keep passing.
/// </para>
/// <para>
/// Note what the gap actually was. The binder ALREADY short-circuited on a
/// receiver that is a <c>BoundErrorExpression</c> NODE — which is why
/// <c>s.NoSuchMember.AlsoMissing.StillMissing</c> reports once, not three
/// times, on origin/main too. That suppression keyed off node identity, and
/// node identity is exactly what a binding loses: once the poison flows through
/// a local (<c>let loaded = broken()</c>) the receiver is a perfectly ordinary
/// variable reference that merely HAS the error TYPE. Keying off the type
/// instead makes the suppression survive inference, which is what every
/// multi-hop case in this family needed.
/// </para>
/// </summary>
public class Issue3887ErrorTypedReceiverCascadeTests
{
    private static List<Diagnostic> Errors(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics.Where(d => d.IsError).ToList();
    }

    /// <summary>
    /// The issue's four-line repro. On origin/main this reports FOUR errors:
    /// the real GS0154 plus three cascades naming <c>Length</c>, <c>IndexOf</c>
    /// and <c>Length</c> — all of which exist on <c>string</c> / <c>[]string</c>.
    /// FAILS on origin/main (4 != 1).
    /// </summary>
    [Fact]
    public void ErrorTypedReceiver_ReportsOnlyTheRootError()
    {
        const string Source = """
            package Issue3887Repro

            class Fixture {
                shared {
                    func Load(paths ...string) []string {
                        return paths
                    }
                }
            }

            class Caller {
                shared {
                    func Go(maybe string?) int32 {
                        let loaded = Fixture.Load(maybe)
                        let first = loaded[0]
                        return first.Length + first.IndexOf("x") + loaded.Length
                    }
                }
            }
            """;

        var errors = Errors(Source);

        var only = Assert.Single(errors);
        Assert.Equal("GS0154", only.Id);
        Assert.DoesNotContain(errors, d => d.Id is "GS0158" or "GS0159");
    }

    /// <summary>
    /// The measured #3886 wall shape, reduced to a single file: ONE bad
    /// argument poisons a local, and every subsequent access on it and on
    /// everything inferred from it cascades. On origin/main this reports
    /// seventeen errors — one real GS0154 and sixteen "Cannot find" — and the
    /// sixteen name reflection surface, which is why the wall was triaged as a
    /// reflection defect. FAILS on origin/main (17 != 1).
    /// </summary>
    [Fact]
    public void SixteenCascadesFromOneRootCause_CollapseToTheOneRealError()
    {
        const string Source = """
            package Issue3887Wall

            import System
            import System.Reflection

            class Fixture {
                shared {
                    func Load(paths ...string) []string {
                        return paths
                    }
                }
            }

            class Caller {
                shared {
                    func Go(maybe string?) int32 {
                        let loaded = Fixture.Load(maybe)
                        let first = loaded[0]
                        let t = first.GetType()
                        let m = t.GetMethod("Foo")
                        let ps = t.GetProperties()
                        let tok = m.MetadataToken
                        let inv = m.Invoke(first, nil)
                        let n = t.Name
                        let asm = t.Assembly
                        let full = t.FullName
                        let bt = t.BaseType
                        let ctor = t.GetConstructors()
                        let flds = t.GetFields()
                        let ifc = t.GetInterfaces()
                        let attrs = t.GetCustomAttributes(false)
                        return first.Length + first.IndexOf("x") + loaded.Length + tok
                    }
                }
            }
            """;

        var errors = Errors(Source);

        var only = Assert.Single(errors);
        Assert.Equal("GS0154", only.Id);
    }

    /// <summary>
    /// Anti-vacuity: four genuinely-missing members on four well-typed
    /// receivers must still produce four distinct diagnostics. A fix that
    /// suppressed too much would be worse than the disease. PASSES on
    /// origin/main — this is a guard rail, not a regression proof.
    /// </summary>
    [Fact]
    public void GenuinelyMissingMembers_OnWellTypedReceivers_AreAllStillReported()
    {
        const string Source = """
            package Issue3887Distinct

            class Bag {
                var Real int32
            }

            class Caller {
                shared {
                    func Go(s string, b Bag) int32 {
                        let a = s.NoSuchMember
                        let c = s.NoSuchFunction()
                        let d = b.NoSuchField
                        let e = b.NoSuchMethod()
                        return 0
                    }
                }
            }
            """;

        var errors = Errors(Source);

        Assert.Equal(4, errors.Count(d => d.Id is "GS0158" or "GS0159"));
        Assert.Contains(errors, d => d.Message.Contains("NoSuchMember"));
        Assert.Contains(errors, d => d.Message.Contains("NoSuchFunction"));
        Assert.Contains(errors, d => d.Message.Contains("NoSuchField"));
        Assert.Contains(errors, d => d.Message.Contains("NoSuchMethod"));
    }

    /// <summary>
    /// Anti-vacuity: the FIRST genuine "cannot find" in a chain is still
    /// reported — suppression only applies downstream of an already-diagnosed
    /// receiver, so a lone bad member access never goes silent. PASSES on
    /// origin/main.
    /// </summary>
    [Fact]
    public void FirstGenuineMissingMemberInAChain_IsStillReported()
    {
        const string Source = """
            package Issue3887Chain

            class Caller {
                shared {
                    func Go(s string) int32 {
                        return s.NoSuchMember.AlsoMissing.StillMissing
                    }
                }
            }
            """;

        var errors = Errors(Source);

        var lookupErrors = errors.Where(d => d.Id is "GS0158" or "GS0159").ToList();
        var only = Assert.Single(lookupErrors);
        Assert.Contains("NoSuchMember", only.Message);
    }

    /// <summary>
    /// The invariant this fix must not violate: suppression changes which
    /// diagnostics are EMITTED, never what BINDS. A program whose only error is
    /// the suppressed cascade's root must still bind and emit the same way, and
    /// a program with no error at all must be bit-identical.
    /// <para>
    /// This is not hypothetical. Two narrower-looking designs broke it, each
    /// caught by <c>Issue710NullConditionalIndexingEmittedSessionTests</c>:
    /// returning early instead of performing the lookup (member resolution has
    /// load-bearing side effects), and dropping the diagnostic in
    /// <c>DiagnosticBag.Add</c> (the binder's speculative rebinds use
    /// <c>Count</c> deltas and <c>TruncateTo</c> as their success signal, so a
    /// never-added entry changes which lookup path the binder commits to).
    /// The shipped design adds the diagnostic exactly as before and filters it
    /// only on read.
    /// </para>
    /// </summary>
    [Fact]
    public void Suppression_DoesNotChangeEmittedIl()
    {
        const string Source = """
            package Issue3887Il

            import System
            import System.Collections.Generic

            class Caller {
                shared {
                    func Go(parts []string) int32 {
                        let lookup = Dictionary[string, int32]()
                        lookup.Add(parts[0], 1)
                        let list = List[string]()
                        list.Add(parts[0].Trim())
                        return lookup.Count + list.Count + parts[0].Length
                    }
                }
            }
            """;

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(Source)));
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "clean code must still emit: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        Assert.NotEqual(0, peStream.Length);
    }

    /// <summary>
    /// Anti-vacuity: long, entirely valid member/call/index chains must still
    /// bind and emit. The suppression keys off <c>TypeSymbol.Error</c>, which no
    /// well-typed receiver ever carries. PASSES on origin/main.
    /// </summary>
    [Fact]
    public void ValidMemberChains_StillBindAndEmit()
    {
        const string Source = """
            package Issue3887Valid

            import System
            import System.Text

            class Caller {
                shared {
                    func Go(parts []string) int32 {
                        let sb = StringBuilder()
                        sb.Append(parts[0].Trim().ToUpperInvariant())
                        let t = sb.ToString().GetType()
                        return sb.ToString().Length + t.Name.Length + parts.Length
                    }
                }
            }
            """;

        Assert.Empty(Errors(Source));
    }
}
