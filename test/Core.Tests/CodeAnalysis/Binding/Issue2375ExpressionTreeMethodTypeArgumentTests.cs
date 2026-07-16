// <copyright file="Issue2375ExpressionTreeMethodTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2375: an imported generic INSTANCE method whose expression-tree parameter's delegate
/// closes over the METHOD's OWN generic type parameter (not merely the declaring type's, which
/// #2365 already covers) — e.g. EF Core's
/// <c>EntityTypeBuilder&lt;TEntity&gt;.HasOne&lt;TRelated&gt;(Expression&lt;Func&lt;TEntity,TRelated&gt;&gt;)</c>
/// — erased the METHOD-level type parameter's occurrences to the wrong type (the RECEIVER's own type
/// argument) or to <c>object</c>, producing an unverifiable assembly (ILVerify <c>StackUnexpected</c>)
/// even though binding itself reported no error.
///
/// Root causes (three independent, EF-agnostic defects in the shared CLR-import substitution engine,
/// all fixed; see also the emit/ILVerify-level companion
/// <c>GSharp.Compiler.Tests.Emit.Issue2375ExpressionTreeMethodTypeArgumentEmitTests</c>):
/// <list type="number">
/// <item><description>
/// <c>MemberLookup.MapOpenClrTypeToSymbolic</c>'s TYPE-level-parameter branch keyed a recovered generic
/// parameter purely by <c>GenericParameterPosition</c> plus <c>DeclaringType</c> — but a METHOD-level CLR
/// <see cref="Type"/> ALSO reports its enclosing type as <c>DeclaringType</c> (contrary to a previously
/// incorrect assumption), so a method type parameter whose position coincidentally collided with the
/// declaring type's own parameter position (both commonly position 0) was misidentified as the type-level
/// parameter and substituted with the RECEIVER's type argument instead of the method's own — corrupting
/// BOTH occurrences of the delegate's parameter/return types to the receiver's entity type (e.g.
/// <c>Expression&lt;Func&lt;Book,Book&gt;&gt;</c> instead of <c>Expression&lt;Func&lt;Book,Conversion&gt;&gt;</c>).
/// Fixed by requiring <c>IsGenericTypeParameter</c> before taking the type-level substitution path.
/// </description></item>
/// <item><description>
/// Even once (1) correctly routed a method-level parameter to the method-level substitution branch, the
/// CALLER — <c>ConversionClassifier.TrySubstituteParameterTypeFromReceiver</c> (used to convert the bound
/// argument to the declared parameter type) — invoked the 3-argument overload of
/// <c>MapOpenClrTypeToSymbolic</c>, which hard-codes empty method type arguments; the method's own already-
/// resolved symbolic type arguments (known to the caller) were never threaded through, so the method-level
/// branch had nothing to substitute with. Fixed by adding an optional <c>symbolicMethodTypeArgs</c>
/// parameter to <c>TrySubstituteParameterTypeFromReceiver</c>, unifying type-level and method-level
/// substitution into the single 5-argument overload (mirroring the sibling
/// <c>TrySubstituteParameterTypeFromMethodTypeArgs</c>, which already did this correctly).
/// </description></item>
/// <item><description>
/// For a FULLY INFERRED call (no explicit method type argument, e.g. <c>.HasOne(e -&gt; e.Conversion)</c>),
/// the method type argument must itself be recovered by unifying the delegate's return position against
/// the deferred lambda's own natural (bound) return type. <c>MemberLookup.UnifyForMethodTypeArgs</c>
/// already had this unification for a BARE <c>Func&lt;...&gt;</c>-shaped open parameter (issue #1334), but
/// never unwrapped an <c>Expression&lt;TDelegate&gt;</c> wrapper first — since a lambda literal's bound
/// type is always its bare <c>FunctionTypeSymbol</c> shape (the <c>Expression&lt;&gt;</c> wrapping only
/// happens via the later argument CONVERSION, never as the lambda's own natural type), the outer arity
/// check against <c>Expression&lt;TDelegate&gt;</c>'s own single type argument always failed, so the method
/// type argument was never inferred at all for this shape. Fixed by unwrapping one <c>Expression&lt;&gt;</c>
/// level before applying the existing #1334 pattern.
/// </description></item>
/// <item><description>
/// A fourth, RETURN-TYPE-specific defect (only reachable once (1)-(3) let the method's own type argument
/// resolve correctly) affects <c>MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs</c>: it derived the
/// call's "open" method via <c>MethodInfo.GetGenericMethodDefinition()</c>, which only re-opens the
/// METHOD's own generic parameters — it leaves the DECLARING TYPE's type arguments exactly as already
/// closed on the selected candidate (e.g. erased to <c>object</c> during overload resolution). For a
/// return type that references BOTH a method-level parameter and the declaring type's own parameter (e.g.
/// <c>Builder&lt;TEntity&gt;.WithOne&lt;TRelated&gt;() : DependentBuilder&lt;TRelated,TEntity&gt;</c>), this
/// left the declaring-type slot permanently erased to <c>object</c> in the call's bound return type even
/// after the method-level slot recovered correctly — breaking any FURTHER chained call against that
/// result (the exact EF <c>.HasOne(...).WithOne(...).HasForeignKey(...)</c> navigation-chain shape). Fixed
/// by re-resolving the truly-open method from the receiver's own open declaring type by metadata-token
/// match (mirroring the existing <c>ExpressionBinder.Calls.TryGetOpenInstanceMethod</c> /
/// <c>ResolveInstanceReturnTypeFromReceiver</c> recovery) before substituting.
/// </description></item>
/// <item><description>
/// A fifth, independently-reachable defect covers the issue's own LITERAL minimal repro — a lambda
/// converting directly to a plain (non-<c>Expression</c>-wrapped) constructed delegate type closed over
/// same-compilation classes, e.g. <c>var f Func[Book, Conversion] = (e Book) -&gt; e.Conversion</c>, with
/// NO imported generic method involved at all. <c>Conversion.IsFunctionToDelegateConvertible</c> — the
/// general "does a func value convert to this CLR delegate type" check used by
/// <c>Conversion.ClassifyCore</c> — resolved the delegate's <c>Invoke</c> signature purely via CLR
/// reflection on the target's (possibly type-erased, per #313/#939) <c>ClrType</c>, AND compared each
/// resolved slot against the SOURCE function's OWN <c>TypeSymbol.ClrType</c> — which is null for any
/// same-compilation class/struct parameter or return type during binding (its real CLR type is only
/// materialized at emit time via <c>TypeBuilder</c>). Both defeat the purely-reflective path even when the
/// two shapes are, symbolically, an exact match. Fixed by adding a new structural (non-reflective) check —
/// <c>Conversion.IsFunctionShapeAssignable</c>, factored out of the pre-existing bare
/// <c>FunctionTypeSymbol</c>-to-<c>FunctionTypeSymbol</c> comparison — that first tries to recover the
/// target's symbolic <c>FunctionTypeSymbol</c> shape via the already-EF-agnostic
/// <c>MemberLookup.TryGetDelegateFunctionTypeFromSymbol</c> (the same helper defect (1)-(3) already rely
/// on) and compares purely by <c>TypeSymbol</c> identity, falling back to the original reflective
/// <c>IsFunctionToDelegateConvertible</c> path only when no symbolic shape can be recovered (e.g. a
/// genuinely still-open generic parameter, or a delegate type with no recorded open-definition/type-argument
/// linkage).
/// </description></item>
/// </list>
/// All four fixes reuse the existing, EF-agnostic <c>MemberLookup.MapOpenClrTypeToSymbolic</c>
/// substitution engine — there is no anonymous-type, EF-specific, or Oahu-specific special case anywhere
/// in any of the fixes.
/// </summary>
public class Issue2375ExpressionTreeMethodTypeArgumentTests
{
    [Fact]
    public void ImportedGenericInstanceMethod_ExplicitMethodTypeArgument_ExpressionReturnPosition_Binds()
    {
        // The explicit-type-argument shape: HasOneRequired[TRelated] is called with TRelated supplied
        // explicitly, so the method's own type argument is never inferred at all — this isolates
        // defects (1) and (2) (the erasure/collision + missing method-type-arg threading) from
        // defect (3) (inference from a deferred lambda body).
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { }
            class Conversion { }

            func Run(b Builder[Book]) {
                b.HasOneRequired[Conversion]((e Book) -> Conversion{})
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedGenericInstanceMethod_InferredMethodTypeArgument_ExpressionReturnPosition_Binds()
    {
        // The real Oahu shape: no explicit type argument at all — TRelated must be recovered purely by
        // unifying the delegate's return slot against the deferred lambda's own inferred return type
        // (defect 3).
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { var Conversion Conversion }
            class Conversion { }

            func Run(b Builder[Book]) {
                b.HasOne((e Book) -> e.Conversion)
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedGenericInstanceMethod_NavigationChain_InferredThroughout_Binds()
    {
        // The exact reported Oahu EF navigation chain shape: HasOne(...).WithOne(...).HasForeignKey(...),
        // every method-type-argument fully inferred, exercising both the method-level-parameter
        // substitution (defects 1-3) AND the chained-call return-type substitution (defect 4) together —
        // WithOne's return type `DependentBuilder[TRelated, TEntity]` mixes a method-level slot
        // (TRelated, from the lambda) with the declaring type's own slot (TEntity, from the receiver),
        // and the immediately following `.HasForeignKey(...)` call requires that return type to be
        // correctly resolved (not erased to `object`) to bind at all.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { var Conversion Conversion }
            class Conversion {
                var BookId int32
                var Book Book
            }

            func Run(b Builder[Book]) {
                b.HasOne((e Book) -> e.Conversion)
                    .WithOne((e Conversion) -> e.Book)
                    .HasForeignKey((e Conversion) -> e.BookId)
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedGenericInstanceMethod_StructRelatedType_Binds()
    {
        // Value-type (struct) TRelated control: the method-level substitution must also work when the
        // inferred/explicit type is a data struct, not just a reference type.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { var Conversion StructConversion }
            data struct StructConversion(Id int32)

            func Run(b Builder[Book]) {
                b.HasOne((e Book) -> e.Conversion)
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedGenericInstanceMethod_NullableReturn_Binds()
    {
        // Nullable-reference-typed TRelated control: the navigation property itself is nullable — the
        // substitution must not lose or corrupt the nullable annotation on the recovered type argument.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { var Conversion Conversion? }
            class Conversion { }

            func Run(b Builder[Book]) {
                b.HasOne((e Book) -> e.Conversion)
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedGenericInstanceMethod_ValueTypeReturn_Binds()
    {
        // Primitive/value-type (non-struct) TRelated control: the delegate's return position closes
        // over int32 rather than a same-compilation user type.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { var Age int32 }

            func Run(b Builder[Book]) {
                b.HasOne((e Book) -> e.Age)
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedGenericInstanceMethod_GenericMethodCalledOnGenericReceiver_OpenControl_Binds()
    {
        // Genuinely-open-generic non-regression control: HasOne is called from INSIDE another generic
        // function, so neither TEntity (the receiver's own type argument) nor TRelated (the method's
        // own, here inferred from a still-open TEntity-typed lambda parameter) is closed at the call
        // site — both remain in-scope G# type parameters. This must keep working exactly as before
        // (issue #313/#671's open in-scope type parameter substitution), unaffected by the #2375 fixes.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Related { }

            func Attach[TEntity](b Builder[TEntity], pick Func[TEntity, Related]) {
                b.HasOne((e TEntity) -> pick(e))
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void NegativeControl_ArityMismatchOnMethodTypeArgumentExpression_StillFailsWithDiagnostic()
    {
        // The lambda supplied for the Expression[Func[TEntity,TRelated]] parameter declares zero
        // parameters where the shape requires exactly one — the generalized method-level substitution
        // must not silently accept an incompatible lambda shape.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { }
            class Conversion { }

            func Run(b Builder[Book]) {
                b.HasOne(() -> Conversion{})
            }
            """,
            expectSuccess: false);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void NegativeControl_UnknownMemberOnChainedResult_StillFailsWithDiagnostic()
    {
        // Sanity control: an unrelated/nonexistent member call on the CHAINED result of a fully-inferred
        // call must not be swallowed by the generalized substitution — it should still fail to resolve.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            class Book { var Conversion Conversion }
            class Conversion { }

            func Run(b Builder[Book]) {
                b.HasOne((e Book) -> e.Conversion).NoSuchMethod()
            }
            """,
            expectSuccess: false);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void DirectPlainFuncTarget_LiteralIssueRepro_NoImportedGenericMethod_Binds()
    {
        // The issue's own literal minimal repro (defect 5): a lambda converts directly to a
        // PLAIN (non-Expression-wrapped) constructed `Func[TEntity,TRelated]` local-variable target,
        // with NO imported library, NO generic method call, and NO Expression<> wrapper involved at
        // all — isolating the standalone `Conversion.IsFunctionToDelegateConvertible` reflection gap
        // from every generic-method-substitution defect (1)-(4) above.
        var result = CompileSingle(
            """
            package Demo

            class Conversion { var Id int32 }
            class Book {
                var Id int32
                var Conversion Conversion
            }

            func Main() {
                var f Func[Book, Conversion] = (e Book) -> e.Conversion
            }
            """);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void DirectPlainFuncTarget_StructRelatedType_Binds()
    {
        // Value-type (struct) control for the direct plain-Func target shape.
        var result = CompileSingle(
            """
            package Demo

            data struct StructConversion(Id int32)
            class Book {
                var Conversion StructConversion
            }

            func Main() {
                var f Func[Book, StructConversion] = (e Book) -> e.Conversion
            }
            """);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void DirectActionTarget_SameCompilationParameterType_Binds()
    {
        // Sibling control: `Action[TEntity]` (void-returning) closed over a same-compilation class
        // parameter must also bind via the same non-reflective structural path — the defect was not
        // return-type-specific; the source lambda's OWN parameter TypeSymbol has no ClrType either.
        var result = CompileSingle(
            """
            package Demo

            class Book { var Id int32 }

            func Main() {
                var a Action[Book] = (e Book) -> { }
            }
            """);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void DirectPlainFuncTarget_GenuinelyOpenGenericControl_StillWidensToObject()
    {
        // Non-regression control: when the delegate is STILL genuinely open (called from inside
        // another generic function, T unresolved at this call site), the pre-existing (deliberate)
        // object-widening behavior for the truly-unresolved slot must be unaffected by this fix —
        // `MemberLookup.TryGetDelegateFunctionTypeFromSymbol`'s `ImportedTypeSymbol` branch explicitly
        // excludes any type argument that still contains an open type parameter, falling back to the
        // original reflective path.
        var result = CompileSingle(
            """
            package Demo

            func Wrap[T](pick Func[T, object]) Func[T, object] {
                return pick
            }
            """);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static void AssertBindsCleanly(EmitResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static EmitResult CompileSingle(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2375.Direct." + Guid.NewGuid().ToString("N"));
    }

    private static EmitResult CompileAgainstLibrary(string consumerSource, bool expectSuccess = true)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2375");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue2375.Library.dll");
        EmitLibraryAssembly(libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        var consumer = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2375.Consumer." + Guid.NewGuid().ToString("N"));

        _ = expectSuccess;
        return result;
    }

    private static void EmitLibraryAssembly(string libraryPath)
    {
        if (File.Exists(libraryPath))
        {
            // Reused across [Fact]s in this class; each test compiles a distinct consumer assembly
            // against the same cached library, mirroring Issue2365's pattern.
            return;
        }

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Lib
                import System
                import System.Linq.Expressions

                class Builder[TEntity] {
                    func HasOneRequired[TRelated](nav Expression[Func[TEntity, TRelated]]) Builder[TRelated] {
                        return Builder[TRelated]{}
                    }

                    func HasOne[TRelated](nav Expression[Func[TEntity, TRelated]]) Builder[TRelated] {
                        return Builder[TRelated]{}
                    }

                    func WithOne[TRelated](nav Expression[Func[TEntity, TRelated]]) DependentBuilder[TRelated, TEntity] {
                        return DependentBuilder[TRelated, TEntity]{}
                    }
                }

                class DependentBuilder[TPrincipal, TDependent] {
                    func HasForeignKey[TDependentEntity](fk Expression[Func[TDependentEntity, object]]) DependentBuilder[TPrincipal, TDependent] {
                        return this
                    }
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2375.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
