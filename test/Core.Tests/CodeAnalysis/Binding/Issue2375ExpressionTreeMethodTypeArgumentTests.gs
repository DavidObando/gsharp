// <copyright file="Issue2375ExpressionTreeMethodTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import Xunit

/// Issue #2375: an imported generic INSTANCE method whose expression-tree parameter's delegate
/// closes over the METHOD's OWN generic type parameter (not merely the declaring type's, which
/// #2365 already covers) — e.g. EF Core's
/// `EntityTypeBuilder<TEntity>.HasOne<TRelated>(Expression<Func<TEntity,TRelated>>)`
/// — erased the METHOD-level type parameter's occurrences to the wrong type (the RECEIVER's own type
/// argument) or to `object`, producing an unverifiable assembly (ILVerify `StackUnexpected`)
/// even though binding itself reported no error.
///
/// Root causes (three independent, EF-agnostic defects in the shared CLR-import substitution engine,
/// all fixed; see also the emit/ILVerify-level companion
/// `GSharp.Compiler.Tests.Emit.Issue2375ExpressionTreeMethodTypeArgumentEmitTests`):
/// 1. `MemberLookup.MapOpenClrTypeToSymbolic`'s TYPE-level-parameter branch keyed a recovered generic
/// parameter purely by `GenericParameterPosition` plus `DeclaringType` — but a METHOD-level CLR
/// (cref:Type) ALSO reports its enclosing type as `DeclaringType` (contrary to a previously incorrect
/// assumption), so a method type parameter whose position coincidentally collided with the declaring
/// type's own parameter position (both commonly position 0) was misidentified as the type-level
/// parameter and substituted with the RECEIVER's type argument instead of the method's own — corrupting
/// BOTH occurrences of the delegate's parameter/return types to the receiver's entity type (e.g.
/// `Expression<Func<Book,Book>>` instead of `Expression<Func<Book,Conversion>>`). Fixed by requiring
/// `IsGenericTypeParameter` before taking the type-level substitution path.
/// 2. Even once (1) correctly routed a method-level parameter to the method-level substitution branch,
/// the CALLER — `ConversionClassifier.TrySubstituteParameterTypeFromReceiver` (used to convert the
/// bound argument to the declared parameter type) — invoked the 3-argument overload of
/// `MapOpenClrTypeToSymbolic`, which hard-codes empty method type arguments; the method's own already-
/// resolved symbolic type arguments (known to the caller) were never threaded through, so the
/// method-level branch had nothing to substitute with. Fixed by adding an optional
/// `symbolicMethodTypeArgs` parameter to `TrySubstituteParameterTypeFromReceiver`, unifying type-level
/// and method-level substitution into the single 5-argument overload (mirroring the sibling
/// `TrySubstituteParameterTypeFromMethodTypeArgs`, which already did this correctly).
/// 3. For a FULLY INFERRED call (no explicit method type argument, e.g. `.HasOne(e -> e.Conversion)`),
/// the method type argument must itself be recovered by unifying the delegate's return position against
/// the deferred lambda's own natural (bound) return type. `MemberLookup.UnifyForMethodTypeArgs` already
/// had this unification for a BARE `Func<...>`-shaped open parameter (issue #1334), but never unwrapped
/// an `Expression<TDelegate>` wrapper first — since a lambda literal's bound type is always its bare
/// `FunctionTypeSymbol` shape (the `Expression<>` wrapping only happens via the later argument
/// CONVERSION, never as the lambda's own natural type), the outer arity check against
/// `Expression<TDelegate>`'s own single type argument always failed, so the method type argument was
/// never inferred at all for this shape. Fixed by unwrapping one `Expression<>` level before applying
/// the existing #1334 pattern.
/// 4. A fourth, RETURN-TYPE-specific defect (only reachable once (1)-(3) let the method's own type
/// argument resolve correctly) affects `MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs`: it
/// derived the call's "open" method via `MethodInfo.GetGenericMethodDefinition()`, which only re-opens
/// the METHOD's own generic parameters — it leaves the DECLARING TYPE's type arguments exactly as
/// already closed on the selected candidate (e.g. erased to `object` during overload resolution). For a
/// return type that references BOTH a method-level parameter and the declaring type's own parameter
/// (e.g. `Builder<TEntity>.WithOne<TRelated>() : DependentBuilder<TRelated,TEntity>`), this left the
/// declaring-type slot permanently erased to `object` in the call's bound return type even after the
/// method-level slot recovered correctly — breaking any FURTHER chained call against that result (the
/// exact EF `.HasOne(...).WithOne(...).HasForeignKey(...)` navigation-chain shape). Fixed by
/// re-resolving the truly-open method from the receiver's own open declaring type by metadata-token
/// match (mirroring the existing `ExpressionBinder.Calls.TryGetOpenInstanceMethod` /
/// `ResolveInstanceReturnTypeFromReceiver` recovery) before substituting.
/// 5. A fifth, independently-reachable defect covers the issue's own LITERAL minimal repro — a lambda
/// converting directly to a plain (non-`Expression`-wrapped) constructed delegate type closed over
/// same-compilation classes, e.g. `var f Func[Book, Conversion] = (e Book) -> e.Conversion`, with NO
/// imported generic method involved at all. `Conversion.IsFunctionToDelegateConvertible` — the general
/// "does a func value convert to this CLR delegate type" check used by `Conversion.ClassifyCore` —
/// resolved the delegate's `Invoke` signature purely via CLR reflection on the target's (possibly
/// type-erased, per #313/#939) `ClrType`, AND compared each resolved slot against the SOURCE function's
/// OWN `TypeSymbol.ClrType` — which is null for any same-compilation class/struct parameter or return
/// type during binding (its real CLR type is only materialized at emit time via `TypeBuilder`). Both
/// defeat the purely-reflective path even when the two shapes are, symbolically, an exact match. Fixed
/// by adding a new structural (non-reflective) check — `Conversion.IsFunctionShapeAssignable`, factored
/// out of the pre-existing bare `FunctionTypeSymbol`-to-`FunctionTypeSymbol` comparison — that first
/// tries to recover the target's symbolic `FunctionTypeSymbol` shape via the already-EF-agnostic
/// `MemberLookup.TryGetDelegateFunctionTypeFromSymbol` (the same helper defect (1)-(3) already rely on)
/// and compares purely by `TypeSymbol` identity, falling back to the original reflective
/// `IsFunctionToDelegateConvertible` path only when no symbolic shape can be recovered (e.g. a
/// genuinely still-open generic parameter, or a delegate type with no recorded
/// open-definition/type-argument linkage).
/// All four fixes reuse the existing, EF-agnostic `MemberLookup.MapOpenClrTypeToSymbolic`
/// substitution engine — there is no anonymous-type, EF-specific, or Oahu-specific special case
/// anywhere
/// in any of the fixes.
open class Issue2375ExpressionTreeMethodTypeArgumentTests {
    @Fact
    func ImportedGenericInstanceMethod_ExplicitMethodTypeArgument_ExpressionReturnPosition_Binds() {
        // The explicit-type-argument shape: HasOneRequired[TRelated] is called with TRelated supplied
        // explicitly, so the method's own type argument is never inferred at all — this isolates
        // defects (1) and (2) (the erasure/collision + missing method-type-arg threading) from
        // defect (3) (inference from a deferred lambda body).
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Book { }
class Conversion { }

func Run(b Builder[Book]) {
    b.HasOneRequired[Conversion]((e Book) -> Conversion{})
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedGenericInstanceMethod_InferredMethodTypeArgument_ExpressionReturnPosition_Binds() {
        // The real Oahu shape: no explicit type argument at all — TRelated must be recovered purely by
        // unifying the delegate's return slot against the deferred lambda's own inferred return type
        // (defect 3).
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Book { var Conversion Conversion }
class Conversion { }

func Run(b Builder[Book]) {
    b.HasOne((e Book) -> e.Conversion)
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedGenericInstanceMethod_NavigationChain_InferredThroughout_Binds() {
        // The exact reported Oahu EF navigation chain shape: HasOne(...).WithOne(...).HasForeignKey(...),
        // every method-type-argument fully inferred, exercising both the method-level-parameter
        // substitution (defects 1-3) AND the chained-call return-type substitution (defect 4) together —
        // WithOne's return type `DependentBuilder[TRelated, TEntity]` mixes a method-level slot
        // (TRelated, from the lambda) with the declaring type's own slot (TEntity, from the receiver),
        // and the immediately following `.HasForeignKey(...)` call requires that return type to be
        // correctly resolved (not erased to `object`) to bind at all.
        let result = CompileAgainstLibrary(`package Demo
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
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedGenericInstanceMethod_StructRelatedType_Binds() {
        // Value-type (struct) TRelated control: the method-level substitution must also work when the
        // inferred/explicit type is a data struct, not just a reference type.
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Book { var Conversion StructConversion }
data struct StructConversion(Id int32)

func Run(b Builder[Book]) {
    b.HasOne((e Book) -> e.Conversion)
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedGenericInstanceMethod_NullableReturn_Binds() {
        // Nullable-reference-typed TRelated control: the navigation property itself is nullable — the
        // substitution must not lose or corrupt the nullable annotation on the recovered type argument.
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Book { var Conversion Conversion? }
class Conversion { }

func Run(b Builder[Book]) {
    b.HasOne((e Book) -> e.Conversion)
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedGenericInstanceMethod_ValueTypeReturn_Binds() {
        // Primitive/value-type (non-struct) TRelated control: the delegate's return position closes
        // over int32 rather than a same-compilation user type.
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Book { var Age int32 }

func Run(b Builder[Book]) {
    b.HasOne((e Book) -> e.Age)
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedGenericInstanceMethod_GenericMethodCalledOnGenericReceiver_OpenControl_Binds() {
        // Genuinely-open-generic non-regression control: HasOne is called from INSIDE another generic
        // function, so neither TEntity (the receiver's own type argument) nor TRelated (the method's
        // own, here inferred from a still-open TEntity-typed lambda parameter) is closed at the call
        // site — both remain in-scope G# type parameters. This must keep working exactly as before
        // (issue #313/#671's open in-scope type parameter substitution), unaffected by the #2375 fixes.
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Related { }

func Attach[TEntity](b Builder[TEntity], pick Func[TEntity, Related]) {
    b.HasOne((e TEntity) -> pick(e))
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func NegativeControl_ArityMismatchOnMethodTypeArgumentExpression_StillFailsWithDiagnostic() {
        // The lambda supplied for the Expression[Func[TEntity,TRelated]] parameter declares zero
        // parameters where the shape requires exactly one — the generalized method-level substitution
        // must not silently accept an incompatible lambda shape.
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Book { }
class Conversion { }

func Run(b Builder[Book]) {
    b.HasOne(() -> Conversion{})
}`, expectSuccess: false)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func NegativeControl_UnknownMemberOnChainedResult_StillFailsWithDiagnostic() {
        // Sanity control: an unrelated/nonexistent member call on the CHAINED result of a fully-inferred
        // call must not be swallowed by the generalized substitution — it should still fail to resolve.
        let result = CompileAgainstLibrary(`package Demo
import Lib

class Book { var Conversion Conversion }
class Conversion { }

func Run(b Builder[Book]) {
    b.HasOne((e Book) -> e.Conversion).NoSuchMethod()
}`, expectSuccess: false)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func DirectPlainFuncTarget_LiteralIssueRepro_NoImportedGenericMethod_Binds() {
        // The issue's own literal minimal repro (defect 5): a lambda converts directly to a
        // PLAIN (non-Expression-wrapped) constructed `Func[TEntity,TRelated]` local-variable target,
        // with NO imported library, NO generic method call, and NO Expression<> wrapper involved at
        // all — isolating the standalone `Conversion.IsFunctionToDelegateConvertible` reflection gap
        // from every generic-method-substitution defect (1)-(4) above.
        let result = CompileSingle(`package Demo

class Conversion { var Id int32 }
class Book {
    var Id int32
    var Conversion Conversion
}

func Main() {
    var f Func[Book, Conversion] = (e Book) -> e.Conversion
}`)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func DirectPlainFuncTarget_StructRelatedType_Binds() {
        // Value-type (struct) control for the direct plain-Func target shape.
        let result = CompileSingle(`package Demo

data struct StructConversion(Id int32)
class Book {
    var Conversion StructConversion
}

func Main() {
    var f Func[Book, StructConversion] = (e Book) -> e.Conversion
}`)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func DirectActionTarget_SameCompilationParameterType_Binds() {
        // Sibling control: `Action[TEntity]` (void-returning) closed over a same-compilation class
        // parameter must also bind via the same non-reflective structural path — the defect was not
        // return-type-specific; the source lambda's OWN parameter TypeSymbol has no ClrType either.
        let result = CompileSingle(`package Demo

class Book { var Id int32 }

func Main() {
    var a Action[Book] = (e Book) -> { }
}`)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func DirectPlainFuncTarget_GenuinelyOpenGenericControl_StillWidensToObject() {
        // Non-regression control: when the delegate is STILL genuinely open (called from inside
        // another generic function, T unresolved at this call site), the pre-existing (deliberate)
        // object-widening behavior for the truly-unresolved slot must be unaffected by this fix —
        // `MemberLookup.TryGetDelegateFunctionTypeFromSymbol`'s `ImportedTypeSymbol` branch explicitly
        // excludes any type argument that still contains an open type parameter, falling back to the
        // original reflective path.
        let result = CompileSingle(`package Demo

func Wrap[T](pick Func[T, object]) Func[T, object] {
    return pick
}`)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    shared {
        private func AssertBindsCleanly(result EmitResult) {
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func CompileSingle(source string) EmitResult {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            using let peStream = MemoryStream()
            return compilation.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue2375.Direct." + Guid.NewGuid().ToString("N")
            )
        }

        private func CompileAgainstLibrary(consumerSource string, expectSuccess bool = true) EmitResult {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2375")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Issue2375.Library.dll")
            EmitLibraryAssembly(libraryPath)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource)))
            using let peStream = MemoryStream()
            let result = consumer.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue2375.Consumer." + Guid.NewGuid().ToString("N")
            )
            return result
        }

        private func EmitLibraryAssembly(libraryPath string) {
            if File.Exists(libraryPath) {
                // Reused across [Fact]s in this class; each test compiles a distinct consumer assembly
                // against the same cached library, mirroring Issue2365's pattern.
                return
            }
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Lib
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
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2375.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
