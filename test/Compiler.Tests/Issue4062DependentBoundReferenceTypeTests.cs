// <copyright file="Issue4062DependentBoundReferenceTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4062: a DEPENDENT constraint propagates the bounding parameter's
/// <c>class</c> constraint, so <c>nil</c> is legal at
/// <c>[TBase class, TDerived TBase]</c>.
/// </summary>
/// <remarks>
/// <para><b>The defect.</b> <c>return nil</c> at a <c>TDerived</c> slot under
/// <c>[TBase class, TDerived TBase]</c> reported
/// <c>GS0155: Cannot convert type 'nil' to 'TDerived'.</c> — measured on
/// <c>origin/main</c> @ <c>7708be7d</c> before anything was written. C#
/// propagates a bounding parameter's special constraints to the bounded one, so
/// <c>TDerived : TBase : class</c> proves <c>TDerived</c> is a reference type in
/// every instantiation and <c>csc</c> accepts <c>TDerived x = null;</c>.
/// <c>[T class]</c> on its own was already accepted (#2354's rule); the
/// reference-ness simply did not travel down a <c>TypeParameterBound</c>
/// chain.</para>
/// <para><b>Root cause and the shape of the repair.</b> #4043 made
/// <c>TypeParameterSymbol.TypeParameterBound</c> a SEPARATE slot from
/// <c>ClassConstraint</c> on purpose: roughly forty consumers read
/// <c>ClassConstraint != null</c> as "this parameter is a reference type" AND
/// as "this is the type it derives from", and the second reading drives boxing
/// and <c>callvirt</c> decisions in the emitter that a dependent bound cannot
/// supply. Merging the slots is #4027's defect shape — a slot that looks like a
/// reference emitting <c>ldnull</c> at a <c>!!T</c> position that is not one.
/// The repair therefore answers only the reference-ness HALF, in one new
/// depth-bounded property (<c>DependentBoundProvesReferenceType</c>) read by
/// exactly ONE consumer,
/// <c>Conversion.IsNilAssignableWithoutNullableWrapper</c>.
/// <c>IsReferenceConstrainedTypeParameter</c> — which also drives
/// <c>IsReferenceLikeTarget</c>'s conversion arms, where <c>ClassConstraint</c>
/// additionally names the type to box or upcast TO — is deliberately left
/// alone, so this widens <c>nil</c> acceptance and nothing else.</para>
/// <para><b>The IL is #4027's shape, not a bare <c>ldnull</c>.</b> The issue
/// asks for <c>default(T)</c> (<c>ldloca; initobj; ldloc</c>) rather than
/// <c>ldnull</c>, and that falls out for free:
/// <c>ConversionClassifier</c> already lowers <c>nil</c> at ANY bare
/// type-parameter target to a <c>BoundDefaultExpression</c> (#4027), so no emit
/// path changed at all. Every green row below IL-verifies and RUNS, and the
/// running rows observe the value — <c>== nil</c> prints <c>True</c> — so
/// "compiles" is never mistaken for "means nil".</para>
/// <para><b>What must stay refused, and why that is the whole soundness
/// argument.</b> A dependent bound whose chain root carries NO <c>class</c>
/// proves nothing: <c>[TBase, TDerived TBase]</c> can be instantiated with a
/// struct, and <c>[TBase struct, TDerived TBase]</c> certainly is one. Both
/// still report <c>GS0155</c>, which is what keeps this a completeness fix
/// rather than a soundness regression — the checker never starts accepting what
/// the CLR refuses.</para>
/// <para><b>Not #4070's rule.</b> Measured, not asserted. #4070 walks
/// <c>ClassConstraint</c> for INTERFACE implication in
/// <c>ClrOverloadResolution</c>; this walks <c>TypeParameterBound</c> for
/// REFERENCE-NESS in <c>TypeParameterSymbol</c>/<c>Conversion</c>. Disjoint
/// slots, disjoint files, and each commit's witness leaves the other's rows
/// unmoved. They share only a PRINCIPLE — a bound implies what the bounding
/// thing proves — which has three entry points that cannot share a helper
/// (the third is filed as #4084).</para>
/// </remarks>
public class Issue4062DependentBoundReferenceTypeTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// Every position at which <c>nil</c> must now be accepted under a
    /// dependent bound whose chain root is <c>class</c>. Each of these reported
    /// <c>GS0155</c> on the parent.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> NilAccepted()
    {
        // THE ISSUE'S OWN REPRO, with the return value observed rather than
        // merely compiled.
        yield return new object[]
        {
            "the-issues-repro-nil-returned-at-a-dependent-bound",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[TBase class, TDerived TBase](d TDerived) TDerived {
                        return nil
                    }
                }
            }

            Console.WriteLine(Fixture.Take[object, string]("a") == nil)
            """,
            new[] { "True" },
        };

        // A LOCAL initialiser rather than a return. Same predicate, different
        // sink — the #4027 lowering has to fire at every one of them.
        yield return new object[]
        {
            "a-local-initialiser-at-a-dependent-bound",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[TBase class, TDerived TBase](d TDerived) bool {
                        var local TDerived = nil
                        return local == nil
                    }
                }
            }

            Console.WriteLine(Fixture.Take[object, string]("a"))
            """,
            new[] { "True" },
        };

        // ARGUMENT position, which routes through
        // OverloadResolver.CallBinding rather than through the ordinary
        // conversion classifier.
        yield return new object[]
        {
            "argument-position-at-a-dependent-bound",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Sink[T](d T) string {
                        if d == nil {
                            return "got-nil"
                        }
                        return "got-value"
                    }

                    func Pass[TBase class, TDerived TBase]() string {
                        return Sink[TDerived](nil)
                    }
                }
            }

            Console.WriteLine(Fixture.Pass[object, string]())
            """,
            new[] { "got-nil" },
        };

        // ASSIGNMENT to an already-declared local — the fourth sink #4027
        // enumerated.
        yield return new object[]
        {
            "assignment-to-a-declared-local-at-a-dependent-bound",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[TBase class, TDerived TBase](d TDerived) bool {
                        var local TDerived = d
                        local = nil
                        return local == nil
                    }
                }
            }

            Console.WriteLine(Fixture.Take[object, string]("a"))
            """,
            new[] { "True" },
        };

        // A CHAIN of depth three, so the walk is a walk and not a single hop.
        yield return new object[]
        {
            "a-three-link-chain-whose-root-carries-class",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Chain[A class, B A, C B](c C) C {
                        var local C = nil
                        return local
                    }
                }
            }

            Console.WriteLine(Fixture.Chain[object, object, string]("a") == nil)
            """,
            new[] { "True" },
        };

        // The ENCLOSING-TYPE shape (#4068's third placement): a generic
        // method's parameter bounded by its CLASS's parameter, which is where
        // the `class` constraint lives.
        yield return new object[]
        {
            "a-method-parameter-bounded-by-the-enclosing-types-class-parameter",
            """
            package P

            import System

            class Box[T class] {
                public func Accept[U T](u U) string {
                    var v U = nil
                    if v == nil {
                        return "nil-ok"
                    }
                    return "not-nil"
                }
            }

            Console.WriteLine(Box[object]().Accept[string]("a"))
            """,
            new[] { "nil-ok" },
        };

        // The root carries a CLASS-BASE bound rather than the bare `class`
        // flag. `IsReferenceConstrainedTypeParameter` treats the two as equally
        // strong proof of reference-ness (#2188), and the chain walk must too.
        yield return new object[]
        {
            "a-chain-whose-root-carries-a-class-base-bound",
            """
            package P

            import System

            open class Animal {
                public var Name string = "a"
            }

            class Fixture {
                shared {
                    func Take[TBase Animal, TDerived TBase](d TDerived) TDerived {
                        return nil
                    }
                }
            }

            Console.WriteLine(Fixture.Take[Animal, Animal](Animal()) == nil)
            """,
            new[] { "True" },
        };

        // CONTROL — #2354's own rule, which this must not disturb: a bare
        // `[T class]` still accepts nil, with the same #4027 lowering.
        yield return new object[]
        {
            "control-a-bare-class-constraint-still-accepts-nil",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[T class](d T) T {
                        return nil
                    }
                }
            }

            Console.WriteLine(Fixture.Take[string]("a") == nil)
            """,
            new[] { "True" },
        };

        // CONTROL — a dependent bound with no nil anywhere still compiles,
        // verifies and runs exactly as #4043 left it. The new property is read
        // only at a nil, so a program without one must be untouched.
        yield return new object[]
        {
            "control-a-dependent-bound-without-a-nil-is-unchanged",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[TBase class, TDerived TBase](d TDerived) TDerived {
                        return d
                    }
                }
            }

            Console.WriteLine(Fixture.Take[object, string]("kept"))
            """,
            new[] { "kept" },
        };
    }

    /// <summary>
    /// Every dependent bound whose chain does NOT prove reference-ness. These
    /// must stay <c>GS0155</c>: a bound over an unconstrained or
    /// value-type-constrained parameter admits a struct, and <c>nil</c> at a
    /// value-type slot is #4027's unverifiable defect.
    /// </summary>
    /// <returns>Case name, G# source.</returns>
    public static IEnumerable<object[]> NilStillRefused()
    {
        // The root is UNCONSTRAINED, so TDerived can be a struct.
        yield return new object[]
        {
            "a-dependent-bound-over-an-unconstrained-root",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[TBase, TDerived TBase](d TDerived) TDerived {
                        return nil
                    }
                }
            }

            Console.WriteLine("x")
            """,
        };

        // The root is `struct`, so TDerived is certainly a value type.
        yield return new object[]
        {
            "a-dependent-bound-over-a-struct-constrained-root",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[TBase struct, TDerived TBase](d TDerived) TDerived {
                        return nil
                    }
                }
            }

            Console.WriteLine("x")
            """,
        };

        // A three-link chain whose ROOT is unconstrained. The walk must reach
        // the root before it answers, not stop at the first link.
        yield return new object[]
        {
            "a-three-link-chain-whose-root-is-unconstrained",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Chain[A, B A, C B](c C) C {
                        return nil
                    }
                }
            }

            Console.WriteLine("x")
            """,
        };

        // The root's only bound is an INTERFACE. C# does not treat an
        // interface constraint as proof of reference-ness either — a struct
        // may implement it — so this stays refused, exactly as a bare
        // `[T IDisposable]` does.
        yield return new object[]
        {
            "a-dependent-bound-over-an-interface-constrained-root",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[TBase IDisposable, TDerived TBase](d TDerived) TDerived {
                        return nil
                    }
                }
            }

            Console.WriteLine("x")
            """,
        };

        // CONTROL, one bound-kind over: a bare unconstrained parameter still
        // refuses nil. This is the rule the chain walk must not have widened
        // past — the walk starts at TypeParameterBound, so a parameter with no
        // bound at all is answered by the pre-existing predicate alone.
        yield return new object[]
        {
            "control-a-bare-unconstrained-parameter-still-refuses-nil",
            """
            package P

            import System

            class Fixture {
                shared {
                    func Take[T](d T) T {
                        return nil
                    }
                }
            }

            Console.WriteLine("x")
            """,
        };
    }

    /// <summary>
    /// <c>nil</c> at a type parameter whose dependent-bound chain roots in
    /// <c>class</c> now compiles, IL-verifies, runs, and observably carries a
    /// null.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(NilAccepted))]
    public void ADependentBoundRootedInClass_AcceptsNil(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4062_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0155", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A dependent bound whose chain does not prove reference-ness still
    /// refuses <c>nil</c> with <c>GS0155</c> — the fix is a completeness fix
    /// and never accepts what the CLR refuses.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    [Theory]
    [MemberData(nameof(NilStillRefused))]
    public void ADependentBoundThatProvesNothing_StillRefusesNil(string name, string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4062_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // Assert the COUNT, not the presence.
            var occurrences = appLog.Split("GS0155", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"'{name}' must report GS0155 exactly once, saw {occurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The chain walk is terminated by VISITED-SYMBOL cycle detection, not by a
    /// depth limit, so a chain that is merely LONG still proves reference-ness
    /// (review of PR #4088). Swept across depths rather than tested at one, for
    /// the reason PR #4068's own replacement of a depth cap failed.
    /// </summary>
    /// <remarks>
    /// <para><b>The finding.</b> The first version used a fixed 32-hop cap.
    /// Measured on that build: <c>[T0 class, T1 T0, … T33 T32]</c> — where the
    /// reference constraint is proven 33 hops away — reported
    /// <c>GS0155: Cannot convert type 'nil' to 'T33'.</c> A cap is a SEMANTIC
    /// answer ("no") to a question about length, which is the wrong shape; the
    /// only thing that may stop the walk is actually revisiting a parameter.
    /// </para>
    /// <para><b>Why a sweep and not one deep row.</b> PR #4068 replaced the same
    /// kind of cap and its first attempt keyed cycle detection on
    /// <c>ClrTypeUtilities.IsSameAs</c>, whose <c>Type.FullName</c> is
    /// <see langword="null"/> for an open constructed generic — so every nested
    /// generic compared equal, a FALSE cycle fired at the first hop, and the
    /// catchable depth collapsed from seven to one while the change looked like
    /// a fix. A single deep row would not have caught that; a SWEEP does,
    /// because a false cycle shows up as the SHALLOW rows failing. The walk here
    /// keys on reference identity of the <c>TypeParameterSymbol</c>, which needs
    /// no name at all and so cannot have that defect — and these rows are what
    /// says so rather than the argument.</para>
    /// </remarks>
    /// <param name="depth">The number of hops from the bounded parameter to the <c>class</c> root.</param>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(7)]
    [InlineData(12)]
    [InlineData(31)]
    [InlineData(32)]
    [InlineData(33)]
    [InlineData(64)]
    public void ALongButValidDependentChain_StillAcceptsNil(int depth)
    {
        // `[T0 class, T1 T0, ... Tdepth T(depth-1)]`, with the nil at `Tdepth`.
        var parameters = new List<string> { "T0 class" };
        for (var i = 1; i <= depth; i++)
        {
            parameters.Add($"T{i} T{i - 1}");
        }

        var arguments = string.Join(", ", Enumerable.Repeat("object", depth + 1));
        var source = $$"""
            package P

            import System

            class Fixture {
                shared {
                    func Deep[{{string.Join(", ", parameters)}}](d T{{depth}}) T{{depth}} {
                        return nil
                    }
                }
            }

            Console.WriteLine(Fixture.Deep[{{arguments}}]("a") == nil)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4062_deep_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, $"Deep{depth}.dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0155", appLog, StringComparison.Ordinal);
            Assert.True(
                File.Exists(appPath),
                $"a {depth}-hop chain rooted in `class` must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"a {depth}-hop chain must run. Exit {exit}:\n{output}");
            Assert.Equal(new[] { "True" }, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The same sweep in the REJECTING direction: however long the chain, a root
    /// that proves nothing still refuses <c>nil</c>. This is what stops the
    /// cycle-detection rewrite from having quietly turned the walk into "answer
    /// yes once it runs out of parameters".
    /// </summary>
    /// <param name="depth">The number of hops to the unconstrained root.</param>
    [Theory]
    [InlineData(1)]
    [InlineData(12)]
    [InlineData(33)]
    public void ALongDependentChainOverAnUnconstrainedRoot_StillRefusesNil(int depth)
    {
        var parameters = new List<string> { "T0" };
        for (var i = 1; i <= depth; i++)
        {
            parameters.Add($"T{i} T{i - 1}");
        }

        var source = $$"""
            package P

            import System

            class Fixture {
                shared {
                    func Deep[{{string.Join(", ", parameters)}}](d T{{depth}}) T{{depth}} {
                        return nil
                    }
                }
            }

            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4062_deepneg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, $"DeepNeg{depth}.dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"a {depth}-hop unconstrained chain must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            var occurrences = appLog.Split("GS0155", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"a {depth}-hop unconstrained chain must report GS0155 exactly once, saw {occurrences}. "
                    + $"Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A CYCLIC dependent bound terminates rather than spinning, and does not
    /// admit <c>nil</c> on the strength of a chain that has no root. #4043
    /// already reports <c>GS0581</c> and CLEARS the bound; this row is what
    /// makes "the visited set is belt-and-braces, not the only thing standing
    /// between us and a hang" a measurement.
    /// </summary>
    [Fact]
    public void ACyclicDependentBound_TerminatesAndStillRefusesNil()
    {
        const string Source = """
            package P

            import System

            class Fixture {
                shared {
                    func Cycle[A B, B A](d A) A {
                        return nil
                    }
                }
            }

            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4062_cyc_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Cycle.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"a cyclic bound must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // #4043's own rule fires, once.
            var cycleOccurrences = appLog.Split("GS0581", StringSplitOptions.None).Length - 1;
            Assert.True(
                cycleOccurrences == 1,
                $"the cycle must report GS0581 exactly once, saw {cycleOccurrences}. Log:\n{appLog}");

            // And the nil is still refused: a cleared cycle proves nothing.
            var nilOccurrences = appLog.Split("GS0155", StringSplitOptions.None).Length - 1;
            Assert.True(
                nilOccurrences == 1,
                $"the nil must report GS0155 exactly once, saw {nilOccurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The emitted IL for a <c>nil</c> at a dependent-bound parameter is
    /// <c>default(T)</c> — <c>ldloca; initobj !!T; ldloc</c> — and NOT a bare
    /// <c>ldnull</c>. That is what the issue asks for, for #4027's reasons:
    /// ECMA-335 III.1.8.1.3 has no rule letting a null reference match a
    /// generic-parameter slot, so <c>ldnull</c> at a <c>!!T</c> position is
    /// <c>[StackUnexpected] [found Nullobjref]</c> no matter what the
    /// constraint says.
    /// </summary>
    /// <remarks>
    /// IL verification alone would catch the wrong shape, but only as a
    /// verifier error; this asserts the OPCODES, so a future lowering that
    /// happens to verify for an unrelated reason cannot silently replace them.
    /// The dependent-bound method's body is compared against the bare
    /// <c>[T class]</c> method's, which #4027 already pinned — the point of
    /// this change is that the two are the same.
    /// </remarks>
    [Fact]
    public void TheEmittedNilIsDefaultOfTAndNotABareLdnull()
    {
        const string Source = """
            package P

            import System

            class Fixture {
                shared {
                    func Dependent[TBase class, TDerived TBase](d TDerived) TDerived {
                        return nil
                    }

                    func Bare[T class](d T) T {
                        return nil
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[object, string]("a") == nil)
            Console.WriteLine(Fixture.Bare[string]("a") == nil)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4062_il_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Il.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"the program must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath);

            var dependentIl = DisassembleMethodBody(appPath, "Dependent");
            var bareIl = DisassembleMethodBody(appPath, "Bare");

            Assert.Contains("initobj", dependentIl, StringComparison.Ordinal);
            Assert.DoesNotContain(
                "ldnull",
                dependentIl,
                StringComparison.Ordinal);

            // The dependent-bound body is the SAME shape #4027 pinned for the
            // bare `class` constraint. Comparing them is what makes "no emit
            // path changed" a measurement rather than a claim.
            Assert.Equal(bareIl, dependentIl);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the program must run. Exit {exit}:\n{output}");
            Assert.Equal(new[] { "True", "True" }, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Returns the opcode names of <paramref name="methodName"/>'s IL body,
    /// with operands stripped so the two generic methods' bodies compare on
    /// SHAPE rather than on their differing type tokens.
    /// </summary>
    /// <param name="assemblyPath">The emitted assembly.</param>
    /// <param name="methodName">The method to disassemble.</param>
    /// <returns>The opcode names, one per line.</returns>
    private static string DisassembleMethodBody(string assemblyPath, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();

        foreach (var handle in reader.MethodDefinitions)
        {
            var definition = reader.GetMethodDefinition(handle);
            if (!string.Equals(reader.GetString(definition.Name), methodName, StringComparison.Ordinal))
            {
                continue;
            }

            var body = peReader.GetMethodBody(definition.RelativeVirtualAddress);
            var il = body.GetILBytes()
                ?? throw new InvalidOperationException($"'{methodName}' has no IL body.");

            var opcodes = new List<string>();
            for (var offset = 0; offset < il.Length;)
            {
                var (name, size) = DecodeOpcode(il, offset);
                opcodes.Add(name);
                offset += size;
            }

            return string.Join("\n", opcodes);
        }

        throw new InvalidOperationException($"method '{methodName}' was not found in {assemblyPath}.");
    }

    /// <summary>
    /// Decodes the opcode at <paramref name="offset"/>, returning its name and
    /// its total size in bytes (opcode plus inline operand). Covers only the
    /// opcodes these two method bodies can contain; anything else fails loudly
    /// rather than mis-parsing.
    /// </summary>
    /// <param name="il">The method's IL bytes.</param>
    /// <param name="offset">The offset to decode at.</param>
    /// <returns>The opcode name and its total encoded size.</returns>
    private static (string Name, int Size) DecodeOpcode(byte[] il, int offset)
    {
        return il[offset] switch
        {
            0x00 => ("nop", 1),
            0x02 => ("ldarg.0", 1),
            0x03 => ("ldarg.1", 1),
            0x06 => ("ldloc.0", 1),
            0x07 => ("ldloc.1", 1),
            0x0A => ("stloc.0", 1),
            0x0B => ("stloc.1", 1),
            0x11 => ("ldloc.s", 2),
            0x12 => ("ldloca.s", 2),
            0x13 => ("stloc.s", 2),
            0x14 => ("ldnull", 1),
            0x25 => ("dup", 1),
            0x2A => ("ret", 1),
            0x38 => ("br", 5),
            0x2B => ("br.s", 2),
            0xFE => il[offset + 1] switch
            {
                0x15 => ("initobj", 6),
                _ => throw new InvalidOperationException($"unexpected two-byte opcode 0xFE{il[offset + 1]:X2}."),
            },
            _ => throw new InvalidOperationException($"unexpected opcode 0x{il[offset]:X2} at offset {offset}."),
        };
    }

    private static string[] SplitLines(string output)
        => output
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .ToArray();

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
