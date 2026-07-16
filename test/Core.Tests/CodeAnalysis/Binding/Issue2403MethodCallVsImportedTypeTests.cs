// <copyright file="Issue2403MethodCallVsImportedTypeTests.cs" company="GSharp">
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
/// Issue #2403: in call position, a user/same-compilation method (or implicit-
/// <c>this</c> instance method) whose name collides with an IMPORTED CLR type
/// used to lose to that type's constructor/conversion fallbacks in
/// <see cref="OverloadResolver.BindCallExpression"/>. The three CLR early-return
/// paths — <c>tryBindClrConstructorCall</c> (real CLR constructor overload
/// resolution), the single-argument conversion-call hijack, and the
/// <c>ClassName(args)</c> primary-constructor path — all ran BEFORE the
/// implicit-<c>this</c> / free-function symbol lookup further down, so a
/// colliding CLR type won unconditionally. Found while rerunning Oahu.Core
/// after #2394: <c>Authorize.HttpClient(IProfile)</c> is a real private
/// instance method, but calls such as <c>HttpClient(profile)</c> (through
/// implicit <c>this</c>) bound to the imported <c>System.Net.Http.HttpClient</c>
/// construction/conversion instead, producing GS0155/GS0490 and subsequent
/// missing-member errors.
///
/// The fix gates all three CLR early-return paths on
/// <c>OverloadResolver.HasUserCallableCandidate</c>: when a same-name user
/// callable (free/extension function, or implicit-<c>this</c> instance/static
/// sibling method — public or private) exists, the CLR paths are skipped and
/// binding falls through to the ordinary call-binding logic, which performs
/// full overload selection and reports the correct diagnostic. When no such
/// candidate exists, the CLR paths run exactly as before, so genuine
/// constructor/conversion calls are unaffected.
/// </summary>
public class Issue2403MethodCallVsImportedTypeTests
{
    [Fact]
    public void PrivateInstanceMethod_ClassArgument_ImportedClrTypeCollision_ResolvesToUserMethod()
    {
        // Minimal repro shape from the issue: `import System.Text` brings the
        // CLR `StringBuilder` type into scope; `Service` also declares a
        // PRIVATE instance method named `StringBuilder` taking a class
        // argument and returning a different local type. The implicit-`this`
        // call must resolve to the private sibling method, not the CLR ctor.
        var source = """
            package p
            import System.Text

            class Profile { var Name string }
            class Result { var Value string }

            class Service {
                private func StringBuilder(profile Profile) Result {
                    return Result{ Value: profile.Name }
                }

                func Run(profile Profile) Result {
                    return StringBuilder(profile)
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void PublicInstanceMethod_ClassArgument_ImportedClrTypeCollision_ResolvesToUserMethod()
    {
        var source = """
            package p
            import System.Text

            class Profile { var Name string }
            class Result { var Value string }

            class Service {
                func StringBuilder(profile Profile) Result {
                    return Result{ Value: profile.Name }
                }

                func Run(profile Profile) Result {
                    return StringBuilder(profile)
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void PrimitiveArgument_ImportedClrTypeCollision_ResolvesToUserMethod()
    {
        // A primitive (int32) argument, rather than a class argument.
        var source = """
            package p
            import System.Text

            class Service {
                func StringBuilder(count int32) int32 {
                    return count * 2
                }

                func Run(count int32) int32 {
                    return StringBuilder(count)
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void NullableReturn_ImportedClrTypeCollision_ResolvesToUserMethod()
    {
        var source = """
            package p
            import System.Text

            class Profile { var Name string }
            class Result { var Value string }

            class Service {
                private func StringBuilder(profile Profile) Result? {
                    return nil
                }

                func Run(profile Profile) Result? {
                    return StringBuilder(profile)
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ZeroArgument_ImportedClrTypeCollision_ResolvesToUserMethod()
    {
        // Control: StringBuilder has a public parameterless constructor, so a
        // zero-argument call is the shape most likely to still be hijacked by
        // the CLR ctor fallback if the fix were incomplete.
        var source = """
            package p
            import System.Text

            class Result { var Value string }

            class Service {
                func StringBuilder() Result {
                    return Result{ Value: "user" }
                }

                func Run() Result {
                    return StringBuilder()
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void MultiArgument_ImportedClrTypeCollision_ResolvesToUserMethod()
    {
        // Control: StringBuilder also has a two-argument constructor
        // (`StringBuilder(string, int32)`), so a two-argument call is another
        // shape the CLR ctor fallback could hijack.
        var source = """
            package p
            import System.Text

            class Profile { var Name string }
            class Result { var Value string }

            class Service {
                private func StringBuilder(a Profile, b Profile) Result {
                    return Result{ Value: a.Name + b.Name }
                }

                func Run(a Profile, b Profile) Result {
                    return StringBuilder(a, b)
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void StaticSelfContext_ImportedClrTypeCollision_ResolvesToUserStaticMethod()
    {
        // Issue #1585 static-self dispatch: an unqualified call inside a
        // `shared` method body must also prefer a same-named `shared` sibling
        // over the colliding imported CLR type.
        var source = """
            package p
            import System.Text

            class Profile { var Name string }
            class Result { var Value string }

            class Service {
                shared {
                    func StringBuilder(profile Profile) Result {
                        return Result{ Value: profile.Name }
                    }

                    func Run(profile Profile) Result {
                        return StringBuilder(profile)
                    }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void InterfaceDefaultMethod_ImportedClrTypeCollision_ResolvesToUserMethod()
    {
        // ADR-0085 / ADR-0090 implicit `this` inside an interface default
        // method body must also prefer the sibling default method over the
        // colliding imported CLR type.
        var source = """
            package p
            import System.Text

            class Profile { var Name string }
            class Result { var Value string }

            interface IService {
                func StringBuilder(profile Profile) Result {
                    return Result{ Value: profile.Name }
                }

                func Run(profile Profile) Result {
                    return StringBuilder(profile)
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenuineConstructorControl_NoUserMethod_StillConstructsClrType()
    {
        // Guardrail: with NO colliding user method anywhere, `StringBuilder(16)`
        // must still resolve to the real CLR constructor (the whole point of
        // the "Phase 4-exit" comment in BindCallExpression).
        var source = """
            package p
            import System.Text

            class Owner {
                func Run() int32 {
                    let sb = StringBuilder(16)
                    return sb.Capacity
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenuineUserClassConstructorControl_NoCollidingFunction_StillConstructs()
    {
        // Guardrail: an ordinary user class's own primary-constructor call
        // (`ClassName(args)`, Phase 3.B.3 sub-step 2 path) must still work when
        // there is no same-named callable to prefer.
        var source = """
            package p

            class Point(X int32, Y int32) {
            }

            class Owner {
                func Run() int32 {
                    let p = Point(1, 2)
                    return p.X
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void WrongArgumentCount_UserMethodStillReportsDiagnostic_NotConstructionFallback()
    {
        // Guardrail: a genuinely wrong-arity call to the colliding user method
        // must still be rejected (mirroring ordinary user-function behavior),
        // not silently reinterpreted through the CLR construction/conversion
        // fallback because HasUserCallableCandidate only checks existence, not
        // arity.
        var source = """
            package p
            import System.Text

            class Profile { var Name string }
            class Result { var Value string }

            class Service {
                private func StringBuilder(profile Profile) Result {
                    return Result{ Value: profile.Name }
                }

                func Run() Result {
                    return StringBuilder()
                }
            }
            """;

        Assert.NotEmpty(Bind(source));
    }

    [Fact]
    public void ExactOahuCoreShape_AuthorizeHttpClient_ResolvesToUserMethod()
    {
        // The exact Oahu.Core Authorize shape from the issue: `import
        // System.Net.Http` brings the CLR `HttpClient` type into scope;
        // `Authorize` declares a PRIVATE instance method named `HttpClient`
        // taking an `IProfile` and returning a nullable `IProfile`. Four call
        // sites through implicit `this` (mirroring the four Authorize call
        // sites the issue references) must all resolve to the user method.
        var source = """
            package p
            import System.Net.Http

            interface IProfile {
                prop Authorization string { get; }
            }

            class Profile : IProfile {
                prop Authorization string { get; set; }
            }

            class Authorize {
                private func HttpClient(profile IProfile) IProfile? {
                    return profile
                }

                func Run(a IProfile, b IProfile, c IProfile, d IProfile) IProfile? {
                    let x = HttpClient(a)
                    let y = HttpClient(b)
                    let z = HttpClient(c)
                    return HttpClient(d)
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
