// <copyright file="CSharpToGSharpTranslator.Nullability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Runtime.CompilerServices

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        // Issue #4356 follow-up: TryGetDeclaringRepositoryMember's owner index
        // and DeclaringRepositoryMemberPromotes' answers (see there).
        private let declaringRepositoryMemberPromotions Dictionary[ISymbol, bool] = Dictionary[ISymbol, bool](
            SymbolEqualityComparer.Default
        )

        private let nonParamsTypeParameterBounds Dictionary[
            (Call SyntaxNode, ParameterName string, TypeParameterOrdinal int32),
            bool
        ] = Dictionary[(Call SyntaxNode, ParameterName string, TypeParameterOrdinal int32), bool]()

        private var repositoryCompilationsByIdentity Dictionary[AssemblyIdentity, CSharpCompilation]?
        private var repositorySharedDocumentPaths HashSet[string]?
        private var refStorageSlots Dictionary[ISymbol, Dictionary[int32, RefStorageSlot]]?
        private var frozenRefStorageContracts Dictionary[ISymbol, HashSet[int32]]?
        private let linkedRefStoragePromotions Dictionary[ISymbol, HashSet[int32]] = Dictionary[
            ISymbol,
            HashSet[int32]
        ](SymbolEqualityComparer.Default)

        private class RefStorageSlot {
            let Symbol ISymbol
            let Depth int32
            var Parent RefStorageSlot? = nil
            var EvaluatingArrays bool = false
            let Members List[RefStorageSlot] = List[RefStorageSlot]()

            init(symbol ISymbol, depth int32) {
                this.Symbol = symbol
                this.Depth = depth
                this.Members.Add(this)
            }

            func Root() RefStorageSlot {
                var root = this
                while root.Parent != nil {
                    root = root.Parent!!
                }
                return root
            }
        }

        // Issue #4146 (Copilot review of #4128's fix): lazily-built cache
        // backing `EmittedAssemblyIdentities()` below — see that method for
        // why this exists (avoids an O(n) `RepositoryCompilations`/
        // `SiblingCompilations` scan on every `TargetContractIsFrozenInMetadata`
        // call) and `TargetContractIsFrozenInMetadata` for why identity
        // (not simple-name string) comparison matters.
        private var emittedAssemblyIdentities HashSet[AssemblyIdentity]?

        // Issue #1072: G# follows Kotlin-style nullability, so `nil`-safety is
        // enforced by the static type, not by a `!!`-on-`nil` escape hatch. A C#
        // symbol DECLARED non-nullable (`T`) but defensively compared against
        // `null`, coalesced in local storage, or assigned `null` / `null!` is, in
        // truth, nullable: faithfully it must render `T?` so the `== nil`/`!= nil`
        // guard type-checks and reads honestly (gsc accepts `== nil` on any
        // reference type, BoundBinaryOperator.IsNullCompare, but a non-null
        // declaration would misstate the value; GS0129 survives only for value
        // types and explicitly non-null imported call results). Returns true when <paramref name="symbol"/> is used
        // that way anywhere in <paramref name="scope"/>.
        private func IsUsedAsNullable(symbol ISymbol?, $scope SyntaxNode?) bool {
            if symbol == nil || $scope == nil {
                return false
            }
            let key = (symbol, $scope)
            if this.state.UsedAsNullableCache.TryGetValue(key, out var cached) {
                return cached
            }
            let result = this.ComputeIsUsedAsNullable(symbol, $scope)
            this.state.UsedAsNullableCache[key] = result
            return result
        }

        private func ComputeIsUsedAsNullable(symbol ISymbol?, $scope SyntaxNode?) bool {
            // A source-backed ProjectReference can expose declaration syntax
            // owned by the referenced project's separate compilation. Its
            // whole-program taint result was already checked by the caller;
            // this local syntax scan is valid only for this compilation.
            if !this.context.Compilation.ContainsSyntaxTree($scope!!.SyntaxTree) {
                return false
            }
            if $scope!!.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                using let modelScope = this.context.UseSemanticModelFor($scope!!.SyntaxTree)
                return this.ComputeIsUsedAsNullable(symbol, $scope)
            }
            return ScopeUsesAsNullable(this.context.SemanticModel, symbol, $scope)
        }

        /// Issue #4356 follow-up: resolves a field or property that another
        /// project of this migration run declares — seen here through that
        /// project's reference assembly, or through a compilation reference —
        /// to its SOURCE declaration in that project's own compilation.
        /// @param symbol The field or property as this compilation binds it.
        /// @param owner The declaring project's compilation.
        /// @param source The declaration in [`owner`](paramref).
        /// @returns True when both were found.
        private func TryGetDeclaringRepositoryMember(
            symbol ISymbol?,
            out owner CSharpCompilation?,
            out source ISymbol?
        ) bool {
            owner = nil
            source = nil
            if !((symbol is IPropertySymbol || symbol is IFieldSymbol)) ||
                symbol!!.ContainingAssembly is not{} assembly ||
                SymbolEqualityComparer
                .Default
                .Equals(assembly, this.context.Compilation.Assembly) ||
                (this.context.RepositoryCompilations ?? this.context.SiblingCompilations) is not{} compilations ||
                symbol!!
                .OriginalDefinition
                .GetDocumentationCommentId() is not{} id {
                return false
            }
            if this.repositoryCompilationsByIdentity == nil {
                this.repositoryCompilationsByIdentity = Dictionary[AssemblyIdentity, CSharpCompilation]()
                for compilation in compilations {
                    if compilation != nil && !object.ReferenceEquals(compilation, this.context.Compilation) {
                        this.repositoryCompilationsByIdentity!!.TryAdd(compilation.Assembly.Identity, compilation)
                    }
                }
            }
            if !this.repositoryCompilationsByIdentity!!.TryGetValue(assembly.Identity, out var candidate) {
                return false
            }
            let declared ISymbol? = DocumentationCommentId.GetFirstSymbolForDeclarationId(id, candidate)
            if declared == nil || !SymbolEqualityComparer.Default.Equals(
                declared.ContainingAssembly,
                candidate.Assembly
            ) ||
                declared
                .DeclaringSyntaxReferences
                .IsDefaultOrEmpty {
                return false
            }
            owner = candidate
            source = declared
            return true
        }

        /// Issue #4356 follow-up: whether a field or property that another
        /// project of this run declares is emitted `T?` there, per
        /// (cref:TryGetDeclaringRepositoryMember) and
        /// (cref:DeclaringCompilationPromotes). The answer is a property
        /// of the declaration, so it is cached per original definition: the
        /// forgiveness predicates ask it from many sites.
        /// @param symbol The field or property as this compilation binds it.
        /// @returns True when the declaring project widens the member.
        private func DeclaringRepositoryMemberPromotes(symbol ISymbol?) bool {
            if !((symbol is IPropertySymbol || symbol is IFieldSymbol)) {
                return false
            }
            let key = symbol!!.OriginalDefinition
            if !this.declaringRepositoryMemberPromotions.TryGetValue(key, out var promotes) {
                promotes = this.TryGetDeclaringRepositoryMember(symbol, out var owner, out var source) &&
                    this.DeclaringCompilationPromotes(owner, source)
                this.declaringRepositoryMemberPromotions[key] = promotes
            }
            return promotes
        }

        /// Issue #4356 follow-up: the declaration-side promotions of
        /// (cref:ShouldPromoteToNullableReference) that only the
        /// DECLARING project can decide — `[AllowNull]` (#3694), which a
        /// reference assembly's consumer cannot see through
        /// (cref:ObliviousNullabilityAnalyzer.HasAllowNullWriteContract)'s
        /// source-only gate, and the #1072 usage scan, whose evidence lives in
        /// the declaring project's syntax. Asked of that project's own
        /// compilation, the answer is the one its translation emitted. The
        /// other promotions (taint, generated-null, pure forwarding) already
        /// consult every compilation of the run.
        /// @param owner The declaring project's compilation.
        /// @param source The member's declaration in [`owner`](paramref).
        /// @returns True when the declaring project emits the member `T?`.
        private func DeclaringCompilationPromotes(owner CSharpCompilation?, source ISymbol?) bool {
            // The producer's own eligibility gate, applied to the DECLARED type:
            // `source` is the original definition, so a consumer's substituted
            // `Box<string>.Value` is judged as `T Value`, which the producer never
            // widens unless `T` is known to be a reference type.
            let declared ITypeSymbol? = switch source {
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                default: default(ITypeSymbol?)
            }
            if !(declared != nil && declared.IsReferenceType == true) ||
                declared.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            if ObliviousNullabilityAnalyzer.HasAllowNullWriteContract(source) {
                return true
            }
            if this.IsDeclaredInRepositorySharedDocument(source) || this.GetNullabilityScope(source) is not{} scope_ ||
                !owner!!.ContainsSyntaxTree(scope_.SyntaxTree) {
                return false
            }
            // The answer depends only on the declaring compilation and the
            // member, so it is cached per compilation for the whole run rather
            // than per consuming document: a test project reads the same few
            // members from thousands of sites.
            return DeclaringUsageScans.GetValue(
                owner!!,
                (_ CSharpCompilation) -> ConcurrentDictionary[ISymbol, bool](SymbolEqualityComparer.Default)
            )
                .GetOrAdd(
                source!!,
                (member ISymbol) -> ScopeUsesAsNullable(owner!!.GetSemanticModel(scope_.SyntaxTree), member, scope_)
            )
        }

        // Issue #3855: true when <paramref name="parameter"/> is a lambda
        // parameter whose rendered type ANNOTATION is an input to the enclosing
        // call's type-argument inference, so promoting it (#1072) would widen an
        // inferred type ARGUMENT rather than merely describe this one position.
        //
        // The distinction that matters is whether the target type is FIXED:
        //
        //   * fixed target (`Action<string> a = s => { if (s == null) … };`, a
        //     non-generic callee, or a generic callee with EXPLICIT type
        //     arguments) — the annotation only has to be COMPATIBLE with the
        //     target, and widening an input position is contravariance, so a
        //     `(string?) -> R` literal still converts to a `(string) -> R`
        //     target. The promotion is a faithful, local statement about what
        //     this body does with the value, and nothing else observes it.
        //
        //   * inferred target (`xs.Where(d => d != null)`) — the annotation is
        //     not checked against a target, it CHOOSES one. gsc infers
        //     `TSource := T?` from `(d T?) -> …`, so the element type of the
        //     whole chain widens and every downstream member access runs on a
        //     nullable receiver (GS0158 / GS0154). That consequence was never
        //     what #1072 intended.
        //
        // Suppressing the promotion here does not cost the `== nil` guard the
        // promotion existed to make legal: gsc admits `x == nil` / `x != nil`
        // on a bare reference class (BoundBinaryOperator's imported-class and
        // `StructSymbol { IsClass: true }` arms), so `(d T) -> d != nil` binds.
        private func LambdaParameterAnnotationFeedsTypeInference(parameter ParameterSyntax) bool {
            if parameter.FirstAncestorOrSelf[AnonymousFunctionExpressionSyntax]() is not{} lambda {
                return false
            }
            // Only a lambda handed DIRECTLY to a call has its parameter type
            // dictated by that call. Anywhere else (a local's initializer, a
            // return, a collection element) the target type is already fixed.
            var node SyntaxNode? = lambda
            while (node!!.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax) {
                node = node!!.Parent
            }
            if node!!.Parent is not ArgumentSyntax argument ||
                argument
                .Parent
                ?.Parent is not InvocationExpressionSyntax invocation {
                return false
            }
            if this.context.GetSymbolInfo(invocation).Symbol is not(IMethodSymbol and {IsGenericMethod: true}) {
                return false
            }
            // Explicit type arguments (`xs.Where<Node>(d => …)`) fix the target
            // before the lambda is ever looked at — nothing is inferred.
            if HasExplicitTypeArguments(invocation.Expression) {
                return false
            }
            let parameterType ITypeSymbol? = (this.context.SemanticModel.GetOperation(argument) as IArgumentOperation)
                ?.Parameter
                ?.OriginalDefinition
                .Type
            if parameterType == nil {
                // The callee could not be resolved to a parameter position. The
                // call IS generic and its type arguments ARE inferred, so the
                // annotation cannot be shown to be inert; suppress.
                return true
            }
            let index = LambdaParameterIndex(lambda, parameter)
            let arrowPosition ITypeSymbol? = DelegateParameterTypeAt(parameterType, index)
            // Fall back to the whole delegate type when the arrow position
            // cannot be isolated: a type-parameter-free delegate parameter
            // (`Func<string, T>`'s input) proves the annotation is inert.
            return MentionsMethodTypeParameter(arrowPosition ?? parameterType)
        }

        private func PromoteIfUsedAsNullable(type GTypeReference?, symbol ISymbol?) GTypeReference? {
            var type = type
            if type == nil {
                return type
            }
            let declaredType ITypeSymbol? = switch symbol {
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                default: default(ITypeSymbol?)
            }
            type = this.PromoteTupleDeclarationIfTainted(type, declaredType, symbol)
            type = this.PromoteObliviousContainerStorage(type, symbol)
            if symbol != nil {
                type = this.PromoteArrayElementIfGeneratedNullElement(type, symbol)
            }
            if type!!.IsNullable {
                return type
            }
            return if this.ShouldPromoteToNullableReference(symbol) {
                MakeNullable(type)
            } else {
                type
            }
        }

        // Issue #3888: a `params T[]` declaration has two distinct nullable
        // positions. The variadic G# spelling drops the array envelope and emits
        // only `...T`, so direct null evidence from EXPANDED arguments must widen
        // that element position without treating a nullable array/carrier as
        // element evidence.
        private func PromoteParamsElementIfUsedAsNullable(
            type GTypeReference?,
            parameter IParameterSymbol,
            elementType ITypeSymbol,
            elementNestedInArrayType bool
        ) GTypeReference? {
            if type == nil ||
                type.IsNullable ||
                !(elementType != nil && elementType.IsReferenceType == true) ||
                elementType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return type
            }
            if !ObliviousNullabilityAnalyzer.IsParamsElementTainted(
                this.context.Compilation,
                parameter,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) &&
                !this.IsWidenedArrayElementStorage(parameter, "0") {
                return type
            }
            return if elementNestedInArrayType && type is ArrayTypeReference array {
                cast[GTypeReference](
                    ArrayTypeReference(MakeNullable(array.ElementType), array.Rank){IsNullable = array.IsNullable}
                )
            } else {
                MakeNullable(type)
            }
        }

        // Issue #2113/#914: method/local-function returns are just another
        // symbol-position declaration sink, so their promote/not-promote answer
        // must come from the shared decision table.
        private func PromoteReturnIfTainted(type GTypeReference?, symbol IMethodSymbol?) GTypeReference? {
            var type = type
            type = this.PromoteObliviousContainerStorage(type, symbol)
            if type != nil && symbol != nil {
                type = this.PromoteArrayElementIfGeneratedNullElement(type, symbol)
            }
            if type == nil || type.IsNullable || symbol == nil {
                return type
            }
            type = this.PromoteArrayReturnElementForNullableSelector(type, symbol)
            return if this.ShouldPromoteToNullableReference(symbol) {
                MakeNullable(type)
            } else {
                type
            }
        }

        private func PromoteArrayReturnElementForNullableSelector(
            type GTypeReference?,
            symbol IMethodSymbol?
        ) GTypeReference? {
            // Issue #4818: the selector's nullable result is the array element
            // contract. Widen that slot instead of asserting each result.
            if !(type is ArrayTypeReference{ElementType: {IsNullable: false} element} array) ||
                symbol!!.ReturnType is not IArrayTypeSymbol returnArray ||
                returnArray.ElementType is not{IsReferenceType: true} returnElement ||
                returnElement.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .None ||
                !this.ArrayReturnElementAcceptsNullableSelectorResult(symbol) {
                return type
            }
            return ArrayTypeReference(MakeNullable(element), array.Rank){IsNullable = array.IsNullable}
        }

        // Issue #2421: mirrors PromoteReturnIfTainted's decision for an `async
        // Task<T>` method/lambda/local function, keyed off the UNWRAPPED
        // awaited type T rather than `symbol.ReturnType` (which for such a
        // member is the `Task<T>` ENVELOPE — always a reference type regardless
        // of whether T is a value or reference type). Calling
        // ShouldPromoteToNullableReference directly would use that envelope for
        // its `declared.IsReferenceType` guard, incorrectly bypassing the
        // guard's protection for a value-typed T (e.g. `Task<int>`, whose
        // awaited result must never become `int?`/`Nullable<int>` through this
        // reference-only promotion). The taint MEMBERSHIP check itself is
        // unchanged: it is the same whole-program symbol-keyed decision
        // (`ObliviousNullabilityAnalyzer.IsTainted`) the synchronous path
        // reaches via ShouldPromoteToNullableReference, since
        // SeedMethodLikeReturnTaint already seeds/propagates taint on the
        // method symbol uniformly regardless of its `Task<T>` envelope — only
        // the CONSUMPTION side (this declaration's own rendered return type)
        // was previously never asked the question at all for an async member.
        private func PromoteAwaitedReturnIfTainted(
            type GTypeReference?,
            awaitedType ITypeSymbol,
            symbol IMethodSymbol?
        ) GTypeReference? {
            var type = this.PromoteObliviousAwaitedResult(type, awaitedType, symbol)
            if type == nil || type.IsNullable || symbol == nil {
                return type
            }
            return if this.AwaitedReturnIsTainted(awaitedType, symbol) {
                MakeNullable(type)
            } else {
                type
            }
        }

        // The promote/not-promote answer PromoteAwaitedReturnIfTainted applies
        // to an unwrapped return element (an awaited `Task<T>` result, or an
        // iterator's `sequence[T]` element). Issue #4578: a `foreach` over a
        // source iterator call asks this same question, so the loop binding and
        // the iterator's rendered element cannot disagree.
        private func AwaitedReturnIsTainted(awaitedType ITypeSymbol?, symbol IMethodSymbol?) bool {
            if !(awaitedType != nil && awaitedType.IsReferenceType == true) ||
                awaitedType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            // Issue #4262 follow-up: unlike `ShouldPromoteToNullableReference`
            // (which requires `declared.NullableAnnotation == None` before ever
            // consulting `IsTainted`), this call site had no such guard — so
            // once #4262 widened `IsTainted`'s entry gate to also answer for an
            // ENABLED asking compilation, a genuinely non-nullable, EXPLICITLY
            // annotated async return type (`NullableAnnotation.NotAnnotated`)
            // could be repainted nullable purely from an oblivious SIBLING's own
            // taint evidence (e.g. an oblivious override/interface-implementation
            // returning `null` — #2285's bidirectional interface/override edges
            // link the two compilations' symbols together in exactly this
            // shape). Verified empirically: an oblivious override of an enabled
            // `virtual async Task<string> M()` returning `null` repainted the
            // ENABLED base declaration itself to `Task<string?>`. Only trust
            // `IsTainted` here when `awaitedType` is itself oblivious (`None`) —
            // the same condition the ordinary declaration path already requires.
            return awaitedType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .None &&
                ObliviousNullabilityAnalyzer.IsTainted(
                this.context.Compilation,
                symbol,
                this.context.SiblingCompilations
            )
        }

        // Issue #4578: whether `foreach` iterates a direct call to a source
        // iterator method whose `sequence[T]` element MapReturnType rendered
        // `T?`. G# infers the loop binding from that element, so the binding is
        // nullable even though the C# loop type is a plain oblivious `T`; the
        // body's member accesses and arguments then need the `!!` that
        // NullableForEachBindings supplies (C# would throw at the same
        // dereference). Mirrors MapReturnType's iterator test and asks the same
        // AwaitedReturnIsTainted question, never a separate computation.
        private func ForEachIteratesPromotedSourceIteratorElement(
            forEach ForEachStatementSyntax,
            forEachInfo ForEachStatementInfo
        ) bool {
            if !forEachInfo.ElementConversion.IsIdentity || !forEach.AwaitKeyword.IsKind(SyntaxKind.None) ||
                CSharpToGSharpTranslator.UnwrapParenthesesAndSuppressions(
                forEach.Expression
            ) is not InvocationExpressionSyntax invocation ||
                this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol invoked {
                return false
            }
            let method = invoked.OriginalDefinition
            if method.ReturnType is not INamedTypeSymbol enumerable ||
                !enumerable.IsGenericType ||
                enumerable.Name != "IEnumerable" {
                return false
            }
            // ADR-0192: a partial method takes the iterator fact from its
            // implementation part's body, exactly as MapReturnType does. A
            // method another project declares has no body here; that binding is
            // already asserted as an imported oblivious collection element
            // (IsImportedObliviousCollectionElement, ADR-0186 `T!`).
            let bodySource = method.PartialImplementationPart ?? method
            let isIterator = bodySource.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> reference.GetSyntax() is MethodDeclarationSyntax methodDeclaration &&
                    IsIteratorBody(methodDeclaration)
            )
            return isIterator && this.AwaitedReturnIsTainted(enumerable.TypeArguments[0], method)
        }

        // Issue #2423: mirrors PromoteAwaitedReturnIfTainted's decision for a
        // NON-async `Task<T>`/`ValueTask<T>`-returning declaration (a C#
        // interface member — interfaces cannot declare `async` members — or a
        // synchronous method that literally returns the envelope). Unlike the
        // async path, there is no `async` keyword here to imply the envelope,
        // so the literal `Task[T]`/`ValueTask[T]` reference from `envelope`
        // must be PRESERVED and only its type ARGUMENT promoted — otherwise an
        // interface declaration and its `async` implementation, once synced by
        // CollectInterfaceMethodEdges, would promote to two structurally
        // different shapes (`Task[T]?` outer-nullable vs `Task[T?]`
        // inner-nullable) that still fail interface-conformance (GS0187).
        private func PromoteTaskEnvelopeReturnIfTainted(
            envelope GTypeReference?,
            awaitedType ITypeSymbol,
            symbol IMethodSymbol?
        ) GTypeReference? {
            if envelope is not NamedTypeReference{TypeArguments: {Count: 1}} named || named.IsNullable {
                return envelope
            }
            var promotedInner GTypeReference? = this.PromoteTupleDeclarationIfTainted(
                named.TypeArguments[0],
                awaitedType,
                symbol
            )
            promotedInner = this.PromoteAwaitedReturnIfTainted(promotedInner, awaitedType, symbol)
            return if object.ReferenceEquals(promotedInner, named.TypeArguments[0]) {
                envelope
            } else {
                cast[GTypeReference](NamedTypeReference(named.Name, []GTypeReference{promotedInner!!}))
            }
        }

        // Issue #2469/#2490: tuple leaves are independent declaration sinks.
        // Their evidence lives in ObliviousNullabilityAnalyzer's element-path
        // graph so tuple returns, parameters, locals, fields/properties, nested
        // tuples, async envelopes, and contracts all converge on the same
        // per-position answer.
        private func PromoteTupleDeclarationIfTainted(
            mapped GTypeReference?,
            returnType ITypeSymbol?,
            symbol ISymbol?
        ) GTypeReference? {
            let path = List[int32]()
            // The analyzer keys iterator leaves under the declared envelope.
            // A sequence element (including a synthesized yield local) is a
            // projection of that position, not a new bare-tuple declaration.
            if ObliviousNullabilityAnalyzer.SymbolValueType(symbol) is INamedTypeSymbol{
                TypeArguments: {Length: 1}
            } envelope &&
                SymbolEqualityComparer
                .Default
                .Equals(returnType, envelope.TypeArguments[0]) {
                path.Add(0)
            }
            return this.PromoteTupleTypeArguments(mapped, returnType, symbol, path)
        }

        // Issue #3641: `var prepared = new List<(string, byte[])>()` renders the
        // CREATED type, not the local's declared type, so promoting only the
        // declaration would leave the initializer's `List[(string, []uint8)]`
        // unconvertible to the promoted `List[(string, []?uint8)]`. G# tuple
        // types agree structurally: the construction that feeds a promoted sink
        // has to be spelled with the same elements. The sink's own element paths
        // are reused directly — the mapper walks the CREATED type's arguments,
        // which coincide with the sink's for the covariant collection hand-offs
        // this shape uses (`List<T>` stored as `IReadOnlyList<T>`) and simply ask
        // an untainted key otherwise.
        private func PromoteCreationTupleArguments(
            type GTypeReference?,
            typeSymbol ITypeSymbol?,
            creation BaseObjectCreationExpressionSyntax
        ) GTypeReference? {
            if type == nil || typeSymbol == nil {
                return type
            }
            let sink ISymbol? = this.ResolveValueSink(creation)
            return if sink == nil {
                type
            } else {
                this.PromoteTupleTypeArguments(type, typeSymbol, sink, List[int32]())
            }
        }

        // The declaration a freshly built value flows into: the local/field being
        // initialized, the assignment target, the invoked parameter, or the
        // enclosing member whose return it is. Mirrors the sinks the analyzer's
        // tuple-flow collectors record edges for, so both sides agree on which
        // declaration owns the element key.
        private func ResolveValueSink(value ExpressionSyntax?) ISymbol? {
            var node SyntaxNode? = value
            while true {
                if (node!!.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax or CheckedExpressionSyntax) {
                    node = node!!.Parent
                    continue
                }
                if node!!.Parent is ConditionalExpressionSyntax conditional &&
                    (conditional.WhenTrue == node || conditional.WhenFalse == node) {
                    node = conditional
                    continue
                }
                if node!!.Parent is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) &&
                    (coalesce.Left == node || coalesce.Right == node) {
                    node = coalesce
                    continue
                }
                if node!!.Parent is SwitchExpressionArmSyntax arm && arm.Expression == node {
                    node = arm.Parent
                    continue
                }
                if node!!.Parent is ArgumentSyntax{Parent: TupleExpressionSyntax tuple} {
                    node = tuple
                    continue
                }
                if node!!.Parent is InitializerExpressionSyntax initializer {
                    node = initializer
                    continue
                }
                if node is InitializerExpressionSyntax &&
                    node.Parent is (
                    BaseObjectCreationExpressionSyntax or
                        ArrayCreationExpressionSyntax or
                        ImplicitArrayCreationExpressionSyntax
                ) {
                    node = node.Parent
                    continue
                }
                if node!!.Parent is ExpressionElementSyntax element {
                    node = element.Parent
                    continue
                }
                break
            }
            switch node!!.Parent {
                case EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator} {
                    return this.context.GetDeclaredSymbol(declarator)
                }
                case EqualsValueClauseSyntax{Parent: PropertyDeclarationSyntax property} {
                    return this.context.GetDeclaredSymbol(property)
                }
                case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) &&
                    assignment.Right == node {
                    let assigned = this.context.GetSymbolInfo(assignment.Left).Symbol
                    let symbol ISymbol? = if assigned != nil &&
                        assigned is not IFieldSymbol{ContainingType: {IsTupleType: true}} {
                        assigned
                    } else if ObliviousNullabilityAnalyzer.TryResolveTupleContainerSource(
                        assignment.Left,
                        this.context.SemanticModel,
                        out var containerOwner,
                        out _,
                        out _,
                        unwrapSuppressions: true
                    ) {
                        containerOwner
                    } else {
                        assigned
                    }
                    return if symbol is IDiscardSymbol {
                        default(ISymbol?)
                    } else {
                        symbol
                    }
                }
                case argument is ArgumentSyntax {
                    return this.GetArgumentParameter(argument)
                }
                case returnStatement is ReturnStatementSyntax {
                    return this.context.SemanticModel.GetEnclosingSymbol(returnStatement.SpanStart) as IMethodSymbol
                }
                case yieldStatement is YieldStatementSyntax {
                    return this.context.SemanticModel.GetEnclosingSymbol(yieldStatement.SpanStart) as IMethodSymbol
                }
                case arrow is ArrowExpressionClauseSyntax {
                    return this.context.SemanticModel.GetDeclaredSymbol(arrow.Parent!!)
                }
                default {
                    return nil
                }
            }
        }

        private func PromoteTupleTypeArguments(
            mapped GTypeReference?,
            declaredType ITypeSymbol?,
            symbol ISymbol?,
            path List[int32]
        ) GTypeReference? -> this
            .typeMapper
            .PromoteTupleTypeArguments(mapped, declaredType, symbol, this.context, path)

        // Issue #914: whether <paramref name="expression"/> yields a
        // promoted-nullable value in an oblivious compilation — either a
        // syntactically nullable form (`?.` / `??` / ternary, via
        // <see cref="IsNullableInitializer"/>, which also consults declared BCL
        // annotations) OR a field / property / local / parameter the whole-program
        // taint analysis promoted to `T?`, OR a method / local function whose
        // return the analysis proved null-tainted.
        private func IsNullablePromotedValue(expression ExpressionSyntax?) bool {
            if expression == nil {
                return false
            }
            // Issue #2496: an anonymous function or method group is a callable
            // value, not the value returned when that callable is invoked.
            // Roslyn binds a lambda to a synthesized IMethodSymbol, so asking the
            // oblivious-nullability fixpoint about that symbol can otherwise
            // mistake return-position taint for nullability of the delegate /
            // Expression<TDelegate> object itself. Keep callable-value
            // nullability separate; lambda result contracts are handled at the
            // lambda body seam instead.
            if this.IsCallableValueExpression(expression) {
                return false
            }
            if this.IsNullableInitializer(expression) {
                return true
            }
            if ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                this.context.Compilation,
                expression,
                this.context.SemanticModel,
                this.context.SiblingCompilations
            ) {
                return true
            }
            // Issue #3663: a DECONSTRUCTING `foreach` variable aliases a tuple
            // leaf without ever naming it, and G#'s `for (a, b) in items` infers
            // each name from the sequence's element tuple. When #3641's
            // nested-tuple promotion renders that element `T?`, the variable IS
            // a nullable value even though its own declaration symbol carries no
            // taint of its own — bridge its reads like any other promoted value.
            if ObliviousNullabilityAnalyzer.IsDeconstructedForEachElementTainted(
                this.context.Compilation,
                expression,
                this.context.SemanticModel,
                this.context.SiblingCompilations
            ) {
                return true
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            return switch symbol {
                case local is ILocalSymbol: this.LocalHoldsPromotedValue(local)
                case _ is IFieldSymbol or
                    _ is IPropertySymbol or
                    _ is IParameterSymbol or
                    _ is IMethodSymbol: this.ShouldPromoteToNullableReference(symbol)
                default: false
            }
        }

        /// Issue #5602: whether [`local`](paramref) holds a value that G# types `T?` in an oblivious
        /// compilation. The receiver rule, the value rules and the store bridge ask this one question.
        /// @remarks A local whose declaration emitted non-null storage (`EmittedLocalStorageAcceptsNil`)
        /// holds a non-null value: the declaration bridged its initializer. A local whose type clause is
        /// `T?` holds a `T?` value. G# infers any other declared local from its initializer. A local that a deconstruction or an `out` argument
        /// declares holds the widened declaration it receives (#5561).
        private func LocalHoldsPromotedValue(local ILocalSymbol) bool {
            // A composed initializer can name the same local in more than one arm, so the answers
            // are kept (`LocalHoldsPromotedValueAnswers`).
            if this.state.LocalHoldsPromotedValueAnswers.TryGetValue(local, out var answer) {
                return answer
            }
            // A local that its own initializer assigns (`object n = (n = e)`) asks about itself. The
            // inner question adds no evidence, so it answers no and the outer question decides.
            if !this.state.LocalHoldsPromotedValueInProgress.Add(local) {
                return false
            }
            var result = false
            try {
                result = this.LocalHoldsPromotedValueCore(local)
            } finally {
                this.state.LocalHoldsPromotedValueInProgress.Remove(local)
            }
            this.state.LocalHoldsPromotedValueAnswers[local] = result
            return result
        }

        private func LocalHoldsPromotedValueCore(local ILocalSymbol) bool {
            // A type clause fixes the storage, so its nullability is the answer. Without a clause, only a
            // certainly non-null initializer gives a certain answer.
            if this
                .state
                .EmittedLocalStorageAcceptsNil
                .TryGetValue(local, out var acceptsNil) &&
                (!acceptsNil || this.state.EmittedLocalTypeClauses.Contains(local)) {
                return acceptsNil
            }
            if this
                .state
                .PatternBindings
                .TryGetValue(local, out var boundReplacement) &&
                this
                .state
                .StoredPatternCaptures
                .Contains(boundReplacement) {
                return true
            }
            if !this.ShouldPromoteToNullableReference(local) &&
                local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} localInitializer}} {
                return this.InitializerHoldsPromotedValue(localInitializer)
            }
            return this.IsTranslatorWidenedDeclaration(local)
        }

        // Issue #5602: whether G# infers `T?` from the initializer of a local. A composed initializer
        // (`a ?? b`, `c ? a : b`, a switch expression) takes the type of its result arms, so each arm
        // is asked `IsNullablePromotedValue`, which reads its taint. A checked cast arm is `T` in G#
        // whatever its operand is (#3843). An arm that a user-defined conversion converts has the type
        // of the operator's result, as `CoerceReferenceValueTo` emits it. An assignment has the type of
        // its destination's storage.
        private func InitializerHoldsPromotedValue(initializer ExpressionSyntax) bool {
            switch initializer {
                case parenthesized is ParenthesizedExpressionSyntax {
                    return this.InitializerHoldsPromotedValue(parenthesized.Expression)
                }
                case checkedExpression is CheckedExpressionSyntax {
                    return this.InitializerHoldsPromotedValue(checkedExpression.Expression)
                }
                case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) &&
                    this
                    .context
                    .GetTypeInfo(assignment)
                    .Type
                    ?.IsReferenceType == true {
                    // An assignment has the type of its destination's storage.
                    return if this.context.GetSymbolInfo(assignment.Left).Symbol is ILocalSymbol destination {
                        this.PatternLocalUsesNullableStorage(assignment.Left) || this.LocalHoldsPromotedValue(
                            destination
                        )
                    } else {
                        !this.AssignmentResultHasNonNullStaticType(assignment)
                    }
                }
                case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                    return this.InitializerHoldsPromotedValue(coalesce.Right)
                }
                case coalesceAssignment is AssignmentExpressionSyntax when coalesceAssignment.IsKind(
                    SyntaxKind.CoalesceAssignmentExpression
                ) {
                    return !this.CoalesceAssignmentResultIsStaticallyNonNull(coalesceAssignment) &&
                        this.InitializerHoldsPromotedValue(coalesceAssignment.Right)
                }
                case conditional is ConditionalExpressionSyntax {
                    return this.InitializerHoldsPromotedValue(conditional.WhenTrue) ||
                        this.InitializerHoldsPromotedValue(conditional.WhenFalse)
                }
                case switchExpression is SwitchExpressionSyntax {
                    return switchExpression.Arms.Any(
                        (arm SwitchExpressionArmSyntax) -> this.InitializerHoldsPromotedValue(arm.Expression)
                    )
                }
                default {
                    if this.GetUserDefinedConversionInputOperator(
                        initializer,
                        this.context.GetTypeInfo(initializer).ConvertedType,
                        out var convertsValue
                    ) is {} conversionOperator &&
                        convertsValue {
                        return this.MapDelegateLikeReturnType(
                            conversionOperator,
                            isAsync: false,
                            initializer.GetLocation()
                        )
                            ?.IsNullable == true
                    }
                    return this.IsNullablePromotedValue(initializer)
                }
            }
        }

        /// Issue #5602: whether a store into the existing local [`target`](paramref) takes a `T?` value
        /// without a bridge. G# types a local by the storage that its declaration emitted, so a local
        /// that holds a `T?` value (`LocalHoldsPromotedValue`) has `T?` storage. A user-defined
        /// conversion still bridges the input of its operator.
        private func LocalStoreAcceptsNil(target ISymbol?) bool -> this.IsObliviousCompilation() &&
            target is ILocalSymbol local &&
            this.LocalHoldsPromotedValue(local)

        // Issue #3676: whether <paramref name="expression"/> reads a
        // generated-code declaration that direct null evidence promoted to
        // `T?` (see
        // <c>ObliviousNullabilityAnalyzer.IsGeneratedDeclarationAssignedNull</c>).
        // This is the nullable-ENABLED counterpart of
        // <see cref="IsNullablePromotedValue"/>, deliberately limited to the one
        // promotion this translator performs there — e.g. the LSP
        // `DocumentUri.FromFileSystemPath(...)` whose `return null` branch makes
        // its result `DocumentUri?`, flowing into a `Location{Uri: …}` slot that
        // no evidence widened.
        private func IsGeneratedDeclarationPromotedValue(expression ExpressionSyntax?) bool {
            if expression == nil || this.IsCallableValueExpression(expression) {
                return false
            }
            let source ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            let compilations IReadOnlyList[CSharpCompilation]? = this
                .context
                .RepositoryCompilations ??
                this
                .context
                .SiblingCompilations
            // Issue #3848: promotion and forgiveness stay symmetric. A value
            // promoted along a pure forwarding edge is `T?` in the emitted G#
            // exactly as a directly-promoted generated declaration is, so it
            // needs the same `!!` when it lands in a sink that KEPT its
            // non-null contract — a hand-authored, nullable-enabled property
            // the C# compiler really did check. Without this the promotion
            // would read as "forwarded nulls are nobody's problem".
            return ObliviousNullabilityAnalyzer.IsGeneratedDeclarationAssignedNull(
                this.context.Compilation,
                source,
                compilations
            ) ||
                ObliviousNullabilityAnalyzer.IsPromotedByPureForwarding(this.context.Compilation, source, compilations)
        }

        // Issue #3848: whether the contextual target of a value position is a
        // declaration this change — and only this change — newly promotes to
        // `T?`. `TranslateValueWithNullForgiveness` asserts unconditionally when
        // `ReceiverNeedsNullForgiveness` fires, BEFORE it ever looks at the
        // target; that ordering was harmless while no promotion could make a
        // return position nullable, and it is why `func Peek(…) Uri? ->
        // Uri.From(fallback)!!` came out asserting a value its own declared
        // return type now accepts. Scoped to the pure-forwarding promotion so
        // every other value position keeps its existing bytes.
        private func IsPureForwardingPromotedTarget(targetSymbol ISymbol?) bool -> targetSymbol != nil &&
            ObliviousNullabilityAnalyzer
            .IsPromotedByPureForwarding(
            this.context.Compilation,
            targetSymbol,
            this.context.RepositoryCompilations ?? this.context.SiblingCompilations
        )

        private func IsCallableValueExpression(expression ExpressionSyntax?) bool {
            var expression = expression
            while expression is ParenthesizedExpressionSyntax parenthesized {
                expression = parenthesized.Expression
            }
            return expression is AnonymousFunctionExpressionSyntax ||
                this
                .context
                .SemanticModel
                .GetMemberGroup(expression!!)
                .Length > 0
        }

        // Issue #914 (oblivious sink): promote the arrow (delegate) parameter
        // positions of <paramref name="symbol"/>'s type to `T?` for every position
        // that receives a null / promoted-nullable argument at an invocation of the
        // parameter inside its own method. A delegate parameter carries no
        // nullability in oblivious metadata, so a call like `sendOrPost(o => …,
        // null)` is the only evidence that the delegate's second position is really
        // `object?`; without it the `nil -> object` argument is rejected (GS0155).
        // This stays separate because delegate arrow-parameter positions have no
        // declaration symbol to ask; the distinct signal is an invocation of the
        // delegate parameter with a null/promoted-nullable argument.
        private func PromoteDelegateParameterInvokedWithNull(
            type GTypeReference?,
            symbol IParameterSymbol
        ) GTypeReference? {
            if !this.IsObliviousCompilation() ||
                type is not ArrowTypeReference arrow ||
                symbol.Type is not INamedTypeSymbol delegateType ||
                delegateType.TypeKind != TypeKind.Delegate ||
                delegateType.DelegateInvokeMethod == nil {
                return type
            }
            let invoke IMethodSymbol? = delegateType.DelegateInvokeMethod
            if invoke!!.Parameters.Length != arrow.ParameterTypes.Count {
                return type
            }
            let methodSyntax SyntaxNode? = symbol
                .ContainingSymbol
                ?.DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax()
            if methodSyntax == nil {
                return type
            }
            let nullablePositions = HashSet[int32]()
            for invocation in methodSyntax.DescendantNodes().OfType[InvocationExpressionSyntax]() {
                if !this.BindsToGuardSymbol(invocation.Expression, symbol) {
                    continue
                }
                let argumentList = invocation.ArgumentList
                for var i = 0; i < argumentList.Arguments.Count && i < arrow.ParameterTypes.Count; i++ {
                    let argument = argumentList.Arguments[i].Expression
                    if IsNullOrDefaultLiteral(argument) || this.IsNullablePromotedValue(argument) {
                        nullablePositions.Add(i)
                    }
                }
            }
            let delegateMetadataName = GetMetadataTypeName(delegateType.OriginalDefinition)
            for tree in this.context.Compilation.SyntaxTrees {
                let model = this.context.Compilation.GetSemanticModel(tree)
                for declaration in tree.GetRoot().DescendantNodes().OfType[DelegateDeclarationSyntax]() {
                    if model.GetDeclaredSymbol(declaration) is not INamedTypeSymbol declarationSymbol ||
                        GetMetadataTypeName(declarationSymbol) != delegateMetadataName {
                        continue
                    }
                    nullablePositions.Clear()
                    for var i = 0; i < declaration.ParameterList.Parameters.Count; i++ {
                        let declaredParameter IParameterSymbol? = model.GetDeclaredSymbol(
                            declaration.ParameterList.Parameters[i]
                        )
                        if declaredParameter == nil {
                            continue
                        }
                        if declaredParameter
                            .Type
                            .NullableAnnotation == Microsoft
                            .CodeAnalysis
                            .NullableAnnotation
                            .Annotated ||
                            ObliviousNullabilityAnalyzer
                            .IsTainted(this.context.Compilation, declaredParameter, this.context.SiblingCompilations) {
                            nullablePositions.Add(i)
                        }
                    }
                }
            }
            if nullablePositions.Count == 0 {
                return type
            }
            let parameterTypes = List[GTypeReference](arrow.ParameterTypes.Count)
            var changed = false
            for var i = 0; i < arrow.ParameterTypes.Count; i++ {
                var parameterType GTypeReference? = arrow.ParameterTypes[i]
                let invokeParameterType = invoke!!.Parameters[i].Type
                if nullablePositions.Contains(i) &&
                    !parameterType!!.IsNullable &&
                    invokeParameterType != nil &&
                    invokeParameterType.IsReferenceType == true &&
                    invokeParameterType.NullableAnnotation != Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    parameterType = MakeNullable(parameterType)
                    changed = true
                }
                parameterTypes.Add(parameterType!!)
            }
            return if changed {
                cast[GTypeReference](
                    ArrowTypeReference(parameterTypes, arrow.ReturnTypes, arrow.IsAsync){IsNullable = arrow.IsNullable}
                )
            } else {
                type
            }
        }

        // Issue #3682: the element type of an array / slice literal that
        // literally writes `null` (or `default`) into a NON-nullable reference
        // element. C# accepts the write — the literal sits in an oblivious file
        // (`test/Core.Tests` has no `<Nullable>` setting), or its element type
        // was inferred from an oblivious/unannotated target — but G#'s element
        // type is genuinely non-nullable and gsc rejects the `nil` (GS0155,
        // `Cannot convert type 'nil' to 'object'`).
        //
        // The right repair is the DECLARATION, not the value: the `nil` really
        // is nil, so `!!` would turn a clean C# `new object[] { a, null }` into
        // a runtime throw. A literal's element type is inferred AT the literal
        // rather than pinned by a declaration, so widening it to `T?` is both
        // faithful and local — the array genuinely holds a nil.
        //
        // Restricted to reference elements whose annotation is not already
        // `Annotated` (those already render `T?`); value-typed elements never
        // receive a `nil` in the first place.
        //
        // Issue #3848 (family B) adds a THIRD source of evidence, and it is the
        // one that is not local to the literal: the DECLARATION this literal is
        // written into may itself have had its element slot promoted (see
        // `PromoteArrayElementIfGeneratedNullElement`). When it has, the literal
        // must widen WITH it whether or not this particular literal contains a
        // maybe-null element — a `[]object` literal does not convert to a
        // `[]object?` slot (gsc GS0155), so promoting the declaration and
        // leaving a second write's literal narrow would stop the project
        // compiling. Symmetry, not extra permissiveness: the decision is the
        // declaration's, taken once, and every write of it follows.
        private func PromoteElementTypeForNullElements(
            mappedElementType GTypeReference?,
            elementTypeSymbol ITypeSymbol?,
            elements IEnumerable[ExpressionSyntax],
            literal ExpressionSyntax? = nil
        ) GTypeReference? {
            // Issue #5541: the positions that oblivious container storage and the
            // elements give the literal's element type, nested positions included.
            var elementType GTypeReference? = if literal != nil {
                this.PromoteObliviousArrayElement(mappedElementType, elementTypeSymbol, literal)
            } else {
                mappedElementType
            }
            if literal != nil {
                let (sink, position) = this.ResolveArrayStorageSink(literal)
                elementType = this.PromoteTupleTypeArguments(
                    elementType,
                    elementTypeSymbol,
                    sink,
                    position
                        .Split('.')
                        .Select((index string) -> int32.Parse(index, CultureInfo.InvariantCulture))
                        .ToList()
                )
            }
            if literal is ImplicitArrayCreationExpressionSyntax implicitArray {
                elementType = this.PromoteInferredDelegateArrayElementType(
                    elementType,
                    elementTypeSymbol,
                    implicitArray
                )
            }
            if elementType == nil ||
                elementType.IsNullable ||
                !(elementTypeSymbol != nil && elementTypeSymbol.IsReferenceType == true) ||
                elementTypeSymbol.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return elementType
            }
            if literal != nil &&
                (
                this.IsGeneratedArrayElementPromotedSink(this.ResolveValueSink(literal)) ||
                    this.IsWidenedArrayCreationElement(literal)
            ) {
                return MakeNullable(elementType)
            }
            for element in elements {
                let projectedElement ITypeSymbol? = if !(literal is ImplicitArrayCreationExpressionSyntax) ||
                    element == nil {
                    default(ITypeSymbol?)
                } else {
                    this.GetManagedReferenceArrayProjectedExpressionType(element)
                }
                if element != nil &&
                    (
                    IsNullOrDefaultLiteral(element) || this.IsNullDataRowRead(element) ||
                        (
                        projectedElement != nil &&
                            projectedElement.IsReferenceType == true &&
                            projectedElement.NullableAnnotation == Microsoft
                            .CodeAnalysis
                            .NullableAnnotation
                            .Annotated
                    )
                ) {
                    return MakeNullable(elementType)
                }
            }
            return elementType
        }

        // Issue #3848 (family B): the DECLARATION half. A generated
        // `object[] Arguments` written `[uri, range.Start]` with a maybe-null
        // `uri` renders `[]object?` — the ELEMENT is widened, never the array
        // (ADR-0132: `[]?T` is the nullable array, `[]T?` the element-nullable
        // one, and it is a value in the array that is null here, not the array).
        //
        // Stated in full on
        // `ObliviousNullabilityAnalyzer.IsGeneratedArrayElementAssignedNull`.
        // This is #3676/#3851's rule — "in generated code the compiler
        // suppressed its nullable diagnostics, so believe the write rather than
        // the annotation it never checked" — read at element granularity. It is
        // NOT #3930's forwarding rule: no promotion propagates along any edge
        // here, and the value written is an ordinary compiler-CHECKED `string?`
        // parameter that `IsPromotedByPureForwarding` rejects outright.
        //
        // The generated restriction is the whole safety boundary, exactly as it
        // is for #3676: a hand-authored `object[]` sink keeps its non-null
        // element type and its element keeps the `!!`, because there the
        // compiler really did check the write (CS8601).
        private func PromoteArrayElementIfGeneratedNullElement(type GTypeReference?, symbol ISymbol) GTypeReference? {
            let declared = ObliviousNullabilityAnalyzer.SymbolValueType(symbol)
            if type == nil || declared is not IArrayTypeSymbol {
                return type
            }
            let positions = HashSet[string](StringComparer.Ordinal)
            var current ITypeSymbol = declared
            var position = "0"
            while current is IArrayTypeSymbol array {
                if this.IsWidenedArrayElementStorage(symbol, position) ||
                    (position == "0" && this.IsGeneratedArrayElementPromotedSink(symbol)) {
                    positions.Add(position)
                }
                current = array.ElementType
                position = JoinPosition(position, "0")
            }
            return PromoteNestedPositions(type, declared, positions, "")
        }

        private func ResolveArrayStorageSink(value ExpressionSyntax?)(Sink ISymbol?, ElementPosition string) {
            if value == nil {
                return (nil, "0")
            }
            var node ExpressionSyntax = value
            let segments = List[string]{"0"}
            while true {
                if node.Parent is (ParenthesizedExpressionSyntax or CastExpressionSyntax or CheckedExpressionSyntax) {
                    node = cast[ExpressionSyntax](node.Parent)
                    continue
                }
                if node.Parent is ConditionalExpressionSyntax conditional &&
                    (conditional.WhenTrue == node || conditional.WhenFalse == node) {
                    node = conditional
                    continue
                }
                if node.Parent is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) &&
                    (coalesce.Left == node || coalesce.Right == node) {
                    node = coalesce
                    continue
                }
                if node.Parent is SwitchExpressionArmSyntax arm &&
                    arm.Expression == node &&
                    arm.Parent is SwitchExpressionSyntax switchExpression {
                    node = switchExpression
                    continue
                }
                if node is InitializerExpressionSyntax &&
                    node.Parent is (ArrayCreationExpressionSyntax or ImplicitArrayCreationExpressionSyntax) {
                    node = cast[ExpressionSyntax](node.Parent)
                    continue
                }
                if node.Parent is InitializerExpressionSyntax initializer && initializer.IsKind(
                    SyntaxKind.ArrayInitializerExpression
                ) {
                    var outer = initializer
                    while outer.Parent is InitializerExpressionSyntax dimension && dimension.IsKind(
                        SyntaxKind.ArrayInitializerExpression
                    ) {
                        outer = dimension
                    }
                    segments.Insert(0, "0")
                    node = outer
                    continue
                }
                if node.Parent is ArgumentSyntax{Parent: TupleExpressionSyntax tuple} argument {
                    let index = tuple.Arguments.IndexOf(argument)
                    if index >= 0 {
                        segments.Insert(0, index.ToString(CultureInfo.InvariantCulture))
                        node = tuple
                        continue
                    }
                }
                break
            }
            let (sink, prefix) = this.DirectValueSink(node)
            var position = prefix
            for segment in segments {
                position = JoinPosition(position, segment)
            }
            return (sink, position)
        }

        private func IsWidenedArrayCreationElement(value ExpressionSyntax?) bool {
            let (sink, elementPosition) = this.ResolveArrayStorageSink(value)
            return this.IsWidenedArrayElementStorage(sink, elementPosition)
        }

        private func IsGeneratedArrayElementPromotedSink(symbol ISymbol?) bool -> symbol != nil &&
            ObliviousNullabilityAnalyzer
            .IsGeneratedArrayElementAssignedNull(
            this.context.Compilation,
            symbol,
            this.context.RepositoryCompilations ?? this.context.SiblingCompilations
        )

        // Issue #3726: #3682's rule stated for a value that is KNOWN nil rather
        // than the literal `nil`. A theory parameter a data row supplies `null`
        // for (`[InlineData(null, …)]`) really does arrive nil on that row, and
        // the element type is still inferred AT the literal — so widening it is
        // the same faithful repair #3682 makes. Bridging with `!!` instead is
        // exactly the "clean C# turned into a runtime throw" that rule rejects:
        // `new[] { flag, … }.Where(a => a is not null)` deliberately tolerates
        // the null, and `flag!!` would throw before the filter ever ran.
        //
        // Deliberately scoped to that attribute-stated evidence rather than to
        // every promoted declaration: generalizing it to the whole taint
        // fixpoint rewrites ~50 files across the corpus (an array literal's
        // element type is load-bearing for what the literal converts to), which
        // is its own decision.
        private func IsNullDataRowRead(expression ExpressionSyntax?) bool {
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            return symbol is IParameterSymbol && ObliviousNullabilityAnalyzer.HasNullDataRowArgument(symbol) &&
                this.ShouldPromoteToNullableReference(symbol)
        }

        // Issue #1072 (field/property initializer form): field/property
        // initializers first consume the shared symbol-position promotion
        // decision, then the distinct direct-initializer signal (`?.`, declared
        // `T?` metadata, etc.) that has no declaration symbol of its own.
        private func PromoteIfInitializerNullable(
            type GTypeReference?,
            symbol ISymbol?,
            initializer ExpressionSyntax
        ) GTypeReference? {
            if type == nil || type.IsNullable || symbol == nil {
                return type
            }
            let declaredType ITypeSymbol? = switch symbol {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: default(ITypeSymbol?)
            }
            if !(declaredType != nil && declaredType.IsReferenceType == true) ||
                declaredType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return type
            }
            return if this.ShouldPromoteToNullableReference(symbol) || this.IsNullableInitializer(initializer) {
                MakeNullable(type)
            } else {
                type
            }
        }

        // Determines whether <paramref name="expression"/> (a field/property
        // initializer) yields a nullable reference value. Because the migrated
        // corpus typically compiles with the nullable context DISABLED, flow
        // nullability is unavailable, so this combines (a) syntactic forms that
        // introduce null (`a?.b`, `a ?? nullableFallback`, `cond ? a : b`) with
        // (b) the bound symbol's DECLARED nullable annotation, which survives in
        // BCL/source metadata regardless of the consuming nullable context
        // (e.g. `AssemblyName.Name` and `Path.GetFileNameWithoutExtension(...)`
        // are declared `string?`). `x!` suppresses nullability.
        private func IsNullableInitializer(expression ExpressionSyntax?) bool {
            if expression == nil {
                return false
            }
            switch expression {
                case paren is ParenthesizedExpressionSyntax {
                    return this.IsNullableInitializer(paren.Expression)
                }
                case suppress is PostfixUnaryExpressionSyntax when suppress.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ) {
                    return false
                }
                case ConditionalAccessExpressionSyntax {
                    return true
                }
                case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                    return this.IsNullableInitializer(coalesce.Right)
                }
                case coalesceAssignment is AssignmentExpressionSyntax when coalesceAssignment.IsKind(
                    SyntaxKind.CoalesceAssignmentExpression
                ) {
                    return !this.CoalesceAssignmentResultIsStaticallyNonNull(coalesceAssignment) &&
                        this.IsNullableInitializer(coalesceAssignment.Right)
                }
                case ternary is ConditionalExpressionSyntax {
                    return this.IsNullableInitializer(ternary.WhenTrue) || this.IsNullableInitializer(ternary.WhenFalse)
                }
            }
            // Issue #5527: an await of a `Task<T?>` where C# runs no flow analysis.
            if expression is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .AwaitExpressionSyntax awaited &&
                this.DeclaredAwaitedResultIsAnnotatedNullable(awaited) {
                return true
            }
            // Flow nullability when the nullable context happens to be enabled.
            let info = this.context.GetTypeInfo(expression)
            if info.Nullability.Annotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
                return true
            }
            // Issue #3802: a `[return: NotNullIfNotNull(nameof(p))]` return is
            // declared `T?` but is exactly as nullable as its named argument,
            // so answer for the ARGUMENT rather than reading the declared `T?`
            // below. The argument's own EMITTED type is what gsc will see, so
            // the taint fixpoint's promotion decision counts here as much as
            // the syntactic one — reading only the latter is what left
            // `Path.GetFileNameWithoutExtension(downloadFileName)` unpromoted
            // in Oahu while `downloadFileName` itself was promoted to `string?`.
            if ConditionalNotNullPostcondition.TryGetForwardedArgument(
                expression,
                func (node ExpressionSyntax) ISymbol? {
                    return this.context.GetSymbolInfo(node).Symbol
                },
                out var conditionalSource
            ) {
                return this.IsNullableInitializer(conditionalSource) || this.ShouldPromoteToNullableReference(
                    this.context.GetSymbolInfo(conditionalSource).Symbol
                )
            }
            // Otherwise consult the bound symbol's declared annotation.
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            let symbolType ITypeSymbol? = switch symbol {
                case m is IMethodSymbol: m.ReturnType
                case p is IPropertySymbol: p.Type
                case f is IFieldSymbol: f.Type
                case l is ILocalSymbol: l.Type
                case pr is IParameterSymbol: pr.Type
                default: default(ITypeSymbol?)
            }
            return symbolType != nil &&
                symbolType.IsReferenceType == true &&
                symbolType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated
        }

        // Issue #3644: the subset of <see cref="IsNullableInitializer"/> whose
        // nullability is written into the EXPRESSION SHAPE itself (`a?.b`,
        // `a ?? nullableFallback`, `cond ? a : b` with a nullable arm) rather
        // than inherited from a bound member's declared `T?` annotation. The
        // runtime-lambda result seam keeps these shapes unasserted (their
        // nullability is deliberate) while a flat declared-annotated member
        // read forwarded as the lambda result is bridged with `!!` to preserve
        // the oblivious C# delegate's non-null return contract.
        private func IsSyntacticallyNullableResultShape(expression ExpressionSyntax?) bool {
            switch expression {
                case paren is ParenthesizedExpressionSyntax {
                    return this.IsSyntacticallyNullableResultShape(paren.Expression)
                }
                case ConditionalAccessExpressionSyntax {
                    return true
                }
                case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                    return this.IsNullableInitializer(coalesce.Right)
                }
                case coalesceAssignment is AssignmentExpressionSyntax when coalesceAssignment.IsKind(
                    SyntaxKind.CoalesceAssignmentExpression
                ) {
                    return !this.CoalesceAssignmentResultIsStaticallyNonNull(coalesceAssignment) &&
                        this.IsNullableInitializer(coalesceAssignment.Right)
                }
                case ternary is ConditionalExpressionSyntax {
                    return this.IsNullableInitializer(ternary.WhenTrue) || this.IsNullableInitializer(ternary.WhenFalse)
                }
                default {
                    return false
                }
            }
        }

        // Issue #1072/#2113/#914: the single translator-side promotion decision
        // for a reference-typed symbol position. Declaration rendering and sink
        // `!!` insertion both route through this helper so a tainted interface/
        // implementation member, local/parameter/property/field, or method return
        // gets the same `T?`/forgiveness treatment everywhere.
        /// Decides whether [`symbol`](paramref) is a declaration that the translator emits as `T?`
        /// although C# declares it non-null: a parameter or `out` parameter that cs2gs widened, or a local
        /// that an `out var x` / `out T x` argument declares for such a parameter, or a local that a
        /// deconstruction declares for such a `Deconstruct` element (G# infers the local's type from the
        /// widened declaration).
        /// @remarks This is the one place that names the declarations whose reads need a forgiving
        /// `!!` when the C# flow state at the read is non-null (issue #5254). The flow-state rule
        /// itself stays in `ReceiverNeedsNullForgiveness`.
        private func IsTranslatorWidenedDeclaration(symbol ISymbol?) bool {
            // The declaration side never widens a variadic carrier (`TranslateParameter`).
            if IsVariadicCarrierParameter(symbol) {
                return false
            }
            // Nor a lambda parameter whose annotation would drive type inference (`MapLambdaParameter`).
            if symbol is IParameterSymbol lambdaParameter &&
                lambdaParameter.ContainingSymbol is IMethodSymbol{MethodKind: MethodKind.AnonymousFunction} &&
                lambdaParameter
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is ParameterSyntax lambdaParameterSyntax &&
                this.LambdaParameterAnnotationFeedsTypeInference(lambdaParameterSyntax) {
                return false
            }
            if this.ShouldPromoteToNullableReference(symbol) {
                return true
            }
            if symbol is not ILocalSymbol local {
                return false
            }
            for reference in local.DeclaringSyntaxReferences {
                // `out var x` declares through a designation; `out T x` through a declaration expression.
                let declaration SyntaxNode? = reference.GetSyntax()?.Parent
                let argumentNode SyntaxNode? = if declaration is DeclarationExpressionSyntax {
                    declaration.Parent
                } else {
                    default(SyntaxNode?)
                }
                if argumentNode is ArgumentSyntax argument && argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword) &&
                    this
                    .context
                    .SemanticModel
                    .GetOperation(argument) is IArgumentOperation{Parameter: {} parameter} &&
                    this.ShouldPromoteToNullableReference(parameter.OriginalDefinition) {
                    return true
                }
            }
            // A deconstructed local (`var (a, b) = e`, `(T a, U b) = e`, `foreach
            // (var (a, b) in items)`) is emitted without a type, so G# infers it
            // from the `Deconstruct` element it receives.
            let element = this.DeconstructedElementDeclaration(local)
            return element != nil && this.IsTranslatorWidenedDeclaration(element)
        }

        // Issue #5508: the declaration whose value a deconstructed local receives
        // (see `ObliviousNullabilityAnalyzer.DeconstructedElementDeclaration`,
        // which also gives the oblivious taint its deconstruction edges, #5561).
        private func DeconstructedElementDeclaration(local ILocalSymbol) ISymbol? {
            return if local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is SingleVariableDesignationSyntax designation {
                ObliviousNullabilityAnalyzer.DeconstructedElementDeclaration(
                    designation,
                    this.context.SemanticModel,
                    this.context.RepositoryCompilations ?? this.context.SiblingCompilations
                )
            } else {
                default(ISymbol?)
            }
        }

        /// Issue #5254: whether G# infers the type of the sink from [`value`](paramref). That holds
        /// for a method type parameter that has no constraint a nullable type argument would break.
        /// A constrained parameter keeps its non-null type argument, so its argument needs the `!!`.
        private func SinkInfersTypeFromValue(
            sink ISymbol?,
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if sink is not IParameterSymbol parameter || !this.IsInferredGenericParameterTarget(parameter, value) {
                return false
            }
            let declared = parameter.OriginalDefinition.Type
            let inferred ITypeSymbol? = if this.IsExpandedParamsArgument(value, parameter) {
                GetParamsElementType(parameter.OriginalDefinition) ?? declared
            } else {
                declared
            }
            return inferred is ITypeParameterSymbol typeParameter &&
                !NullableTypeArgumentViolatesTranslatedConstraints(typeParameter) &&
                !this.OtherArgumentFixesTypeParameterToNonNull(value, parameter, typeParameter)
        }

        private func EmittedExpandedParamsElementMayBeNull(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            var current = expression
            while (
                current is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .CheckedExpressionSyntax
            ) {
                current = switch current {
                    case parenthesized is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax: parenthesized.Expression
                    case checkedExpression is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .CheckedExpressionSyntax: checkedExpression.Expression
                    default: current
                }
            }
            if current == nil || IsNullOrSuppressedNull(current) || current.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression
            ) ||
                current is DefaultExpressionSyntax {
                return true
            }
            if current is CastExpressionSyntax castExpression && this.IsNullPreservingReferenceCast(castExpression) {
                return this.EmittedExpandedParamsElementMayBeNull(castExpression.Expression)
            }
            if current is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax conditional {
                return this.EmittedExpandedParamsElementMayBeNull(conditional.WhenTrue) ||
                    this.EmittedExpandedParamsElementMayBeNull(conditional.WhenFalse)
            }
            if current is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax switchExpression {
                return switchExpression.Arms.Any(
                    (arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax) ->
                    this.EmittedExpandedParamsElementMayBeNull(arm.Expression)
                )
            }
            if current is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax coalesce && coalesce.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression
            ) {
                return this.EmittedExpandedParamsElementMayBeNull(coalesce.Right)
            }
            if current is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .AssignmentExpressionSyntax coalesceAssignment &&
                coalesceAssignment
                .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceAssignmentExpression) {
                return !this.CoalesceAssignmentResultIsStaticallyNonNull(coalesceAssignment) &&
                    this.EmittedExpandedParamsElementMayBeNull(coalesceAssignment.Right)
            }
            if this.GetExpressionNullablePositions(current) is {} positions &&
                (positions.Nullable.Contains("") || positions.Platform.Contains("")) {
                return true
            }
            return this.NullableReferenceValueMayBeNull(
                current,
                respectDeclaredAnnotations: true,
                respectDeclaredCallResults: true
            )
        }

        private func OtherArgumentFixesTypeParameterToNonNull(
            callSite Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            parameter IParameterSymbol,
            typeParameter ITypeParameterSymbol
        ) bool {
            if parameter.ContainingSymbol is IMethodSymbol{Parameters: {Length: 1}, ReducedFrom: nil} ||
                parameter.ContainingSymbol is IPropertySymbol{Parameters: {Length: 1}} {
                return false
            }
            let enclosingArgument ArgumentSyntax? = if callSite == nil {
                default(ArgumentSyntax?)
            } else {
                this.FindEnclosingArgumentThroughReferenceCasts(callSite)
            }
            if enclosingArgument?.Parent is not BaseArgumentListSyntax argumentList || argumentList.Parent == nil {
                return false
            }
            let callNode = argumentList.Parent!!
            let cacheKey = (callNode, parameter.Name, typeParameter.Ordinal)
            if this.nonParamsTypeParameterBounds.TryGetValue(cacheKey, out var cached) {
                return cached
            }
            let computed = this.ComputeOtherArgumentFixesTypeParameterToNonNull(
                callNode,
                argumentList,
                enclosingArgument,
                parameter,
                typeParameter
            )
            this.nonParamsTypeParameterBounds[cacheKey] = computed
            return computed
        }

        private func ComputeOtherArgumentFixesTypeParameterToNonNull(
            callNode SyntaxNode,
            argumentList BaseArgumentListSyntax,
            enclosingArgument ArgumentSyntax?,
            parameter IParameterSymbol,
            typeParameter ITypeParameterSymbol
        ) bool {
            let receiverExpression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = switch callNode {
                case InvocationExpressionSyntax{
                    Expression: MemberAccessExpressionSyntax memberAccess
                }: memberAccess.Expression
                case InvocationExpressionSyntax{Expression: MemberBindingExpressionSyntax} bindingCall: bindingCall
                    .Ancestors()
                    .OfType[ConditionalAccessExpressionSyntax]()
                    .FirstOrDefault()
                    ?.Expression
                default: default(Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?)
            }
            if receiverExpression != nil &&
                this
                .context
                .GetSymbolInfo(callNode)
                .Symbol is IMethodSymbol{ReducedFrom: {} reducedFrom} &&
                reducedFrom
                .OriginalDefinition
                .Parameters
                .FirstOrDefault() is {} receiverParameter {
                let receiverType ITypeSymbol? = this.GetExpressionInferenceType(receiverExpression)
                let initialVariance = if receiverParameter.RefKind != RefKind.None {
                    VarianceKind.None
                } else {
                    VarianceKind.Out
                }
                if receiverType != nil &&
                    ParameterArgumentPreventsNullableInference(
                    receiverParameter.Type,
                    receiverType,
                    this.GetExpressionNullablePositions(receiverExpression),
                    typeParameter,
                    initialVariance
                ) {
                    return true
                }
            }
            for var i = 0; i < argumentList.Arguments.Count; i++ {
                let otherArgument = argumentList.Arguments[i]
                if otherArgument == enclosingArgument || (otherArgument.NameColon == nil && i >= parameter.Ordinal) {
                    continue
                }
                let otherParameter IParameterSymbol? = this.GetArgumentParameter(otherArgument)
                if otherParameter == nil || otherParameter.Name == parameter.Name {
                    continue
                }
                let argumentType ITypeSymbol? = this.GetExpressionInferenceType(
                    otherArgument.Expression,
                    otherArgument,
                    otherParameter
                )
                if argumentType == nil {
                    continue
                }
                let isEmittedIn = otherArgument.RefKindKeyword.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.InKeyword
                ) ||
                    (
                    this.TargetsSourceDeclaredInParameter(otherArgument) && this.PassesInArgumentWithoutConversion(
                        otherArgument
                    )
                )
                let initialVariance = if (otherParameter.RefKind is RefKind.Ref or RefKind.Out) || isEmittedIn {
                    VarianceKind.None
                } else {
                    VarianceKind.Out
                }
                if ParameterArgumentPreventsNullableInference(
                    otherParameter.OriginalDefinition.Type,
                    argumentType,
                    this.GetExpressionNullablePositions(otherArgument.Expression),
                    typeParameter,
                    initialVariance
                ) {
                    return true
                }
            }
            return false
        }

        private func GetExpressionNullablePositions(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) ObliviousPositionSet? {
            let dropsTopLevelSuppression = expression?.Parent is ArgumentSyntax parentArgument &&
                this.PassesArgumentStorageUnasserted(parentArgument)
            var unwrapped = expression
            var suppressedTopLevel = false
            while (
                unwrapped is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .CheckedExpressionSyntax or
                    PostfixUnaryExpressionSyntax and
                    {RawKind: int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression)}
            ) {
                if unwrapped is PostfixUnaryExpressionSyntax && !dropsTopLevelSuppression {
                    suppressedTopLevel = true
                }
                unwrapped = switch unwrapped {
                    case parenthesized is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax: parenthesized.Expression
                    case checkedExpression is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .CheckedExpressionSyntax: checkedExpression.Expression
                    case postfix is PostfixUnaryExpressionSyntax: postfix.Operand
                    default: unwrapped
                }
            }
            if unwrapped == nil {
                return nil
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(unwrapped).Symbol
            if symbol is IMethodSymbol callableMethod &&
                (
                unwrapped is AnonymousFunctionExpressionSyntax ||
                    (
                    callableMethod.MethodKind != MethodKind.Constructor &&
                        !(unwrapped is InvocationExpressionSyntax) &&
                        !(unwrapped is BaseObjectCreationExpressionSyntax)
                )
            ) {
                return this.ProjectCallableNullablePositions(unwrapped, callableMethod)
            }
            var result ObliviousPositionSet? = nil
            if this.ConvertedObliviousPositionsOf(
                unwrapped,
                this.context.SemanticModel,
                this.ObliviousContainerFlowState()
            ) is {} valuePositions {
                result = ObliviousPositionSet()
                result.UnionWith(valuePositions)
            }
            if this.UserDefinedConversionOperator(unwrapped, this.context.SemanticModel) is {} conversionOperator {
                if !suppressedTopLevel &&
                    (
                    this.ShouldPromoteToNullableReference(conversionOperator) || this.IsTranslatorWidenedDeclaration(
                        conversionOperator
                    )
                ) {
                    result ??= ObliviousPositionSet()
                    result!!.Nullable.Add("")
                }
                if suppressedTopLevel && result != nil {
                    result.Nullable.Remove("")
                    result.Platform.Remove("")
                }
                return result
            }
            if !suppressedTopLevel &&
                symbol != nil &&
                (
                this.ShouldPromoteToNullableReference(symbol) || this.IsTranslatorWidenedDeclaration(symbol) ||
                    this
                    .GetDeclaredValueType(unwrapped)
                    ?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            ) {
                result ??= ObliviousPositionSet()
                result!!.Nullable.Add("")
            }
            if symbol != nil && !(symbol is ILocalSymbol) {
                let declared = this.ObliviousContainerPositions(symbol)
                if declared != nil && declared.Count > 0 {
                    result ??= ObliviousPositionSet()
                    result!!.Nullable.UnionWith(declared)
                }
            }
            if suppressedTopLevel && result != nil {
                result.Nullable.Remove("")
                result.Platform.Remove("")
            }
            return result
        }

        private func ProjectCallableNullablePositions(
            unwrapped Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            callableMethod IMethodSymbol
        ) ObliviousPositionSet? {
            if this
                .context
                .GetTypeInfo(unwrapped)
                .ConvertedType is not INamedTypeSymbol{TypeKind: TypeKind.Delegate} named ||
                named
                .OriginalDefinition
                .DelegateInvokeMethod is not{} invokeDefinition {
                return nil
            }
            let definition = named.OriginalDefinition
            if definition
                .TypeParameters
                .Length == 0 ||
                callableMethod
                .Parameters
                .Length != invokeDefinition
                .Parameters
                .Length {
                return nil
            }
            let bindings = TypeParameterMap()
            let boundParameters = HashSet[ITypeParameterSymbol](SymbolEqualityComparer.Default)
            for var i = 0; i < invokeDefinition.Parameters.Length; i++ {
                let parameterSymbol = callableMethod.Parameters[i]
                let parameterPositions = this.GetCallableSymbolNullablePositions(parameterSymbol)
                let parameterVariance = if invokeDefinition.Parameters[i].RefKind != RefKind.None {
                    VarianceKind.None
                } else {
                    VarianceKind.In
                }
                MergeCallableSlotPositions(
                    invokeDefinition.Parameters[i].Type,
                    parameterSymbol.Type,
                    parameterPositions,
                    parameterVariance,
                    bindings,
                    boundParameters
                )
            }
            let returnVariance = if invokeDefinition.ReturnsByRef || invokeDefinition.ReturnsByRefReadonly {
                VarianceKind.None
            } else {
                VarianceKind.Out
            }
            if !(unwrapped is AnonymousFunctionExpressionSyntax) && !invokeDefinition.ReturnsVoid {
                let returnPositions = this.GetCallableSymbolNullablePositions(callableMethod)
                MergeCallableSlotPositions(
                    invokeDefinition.ReturnType,
                    callableMethod.ReturnType,
                    returnPositions,
                    returnVariance,
                    bindings,
                    boundParameters
                )
            } else if unwrapped is AnonymousFunctionExpressionSyntax anonymousFunction &&
                !invokeDefinition
                .ReturnsVoid {
                var returnPositions ObliviousPositionSet? = nil
                for returnExpression in GetLambdaResultExpressions(anonymousFunction) {
                    if this.GetExpressionNullablePositions(returnExpression) is {} expressionPositions {
                        returnPositions ??= ObliviousPositionSet()
                        returnPositions!!.UnionWith(expressionPositions)
                    }
                }
                if anonymousFunction.AsyncKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword) &&
                    returnPositions != nil {
                    returnPositions = Prefixed(returnPositions, "0")
                }
                MergeCallableSlotPositions(
                    invokeDefinition.ReturnType,
                    callableMethod.ReturnType,
                    returnPositions,
                    returnVariance,
                    bindings,
                    boundParameters
                )
            }
            if bindings.Count == 0 {
                return nil
            }
            let result = ObliviousPositionSet()
            Substitute(definition, bindings, "", result)
            return if result.IsEmpty {
                nil
            } else {
                result
            }
        }

        private func GetCallableSymbolNullablePositions(symbol ISymbol) ObliviousPositionSet? {
            var result ObliviousPositionSet? = nil
            let promotedTopLevel = if symbol is IParameterSymbol{
                ContainingSymbol: IMethodSymbol{MethodKind: MethodKind.AnonymousFunction}
            } {
                this.IsTranslatorWidenedDeclaration(symbol)
            } else {
                this.ShouldPromoteToNullableReference(symbol) || this.IsTranslatorWidenedDeclaration(symbol)
            }
            if promotedTopLevel {
                result ??= ObliviousPositionSet()
                result!!.Nullable.Add("")
            }
            let declared = this.ObliviousContainerPositions(symbol)
            if declared != nil && declared.Count > 0 {
                result ??= ObliviousPositionSet()
                result!!.Nullable.UnionWith(declared)
            }
            if this.IsFrozenObliviousImportMember(symbol) {
                result ??= ObliviousPositionSet()
                CollectPlatformPositions(StorageType(UnreducedDefinition(symbol)), "", result!!.Platform)
            }
            return result
        }

        private func GetExpressionInferenceType(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            argument ArgumentSyntax? = nil,
            parameter IParameterSymbol? = nil
        ) ITypeSymbol? {
            var current = expression
            while (
                current is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .CheckedExpressionSyntax or
                    PostfixUnaryExpressionSyntax and
                    {RawKind: int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression)}
            ) {
                current = switch current {
                    case parenthesized is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax: parenthesized.Expression
                    case checkedExpression is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .CheckedExpressionSyntax: checkedExpression.Expression
                    case postfix is PostfixUnaryExpressionSyntax: postfix.Operand
                    default: current
                }
            }
            if current == nil {
                return nil
            }
            if IsNullOrSuppressedNull(current) {
                return if argument != nil && this.LowersNullArgumentToTypedDefault(argument, parameter) {
                    (this.context.GetTypeInfo(current).ConvertedType ?? parameter?.Type)?.WithNullableAnnotation(
                        Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated
                    )
                } else {
                    default(ITypeSymbol?)
                }
            }
            if this.UserDefinedConversionOperator(current, this.context.SemanticModel) is {} conversionOperator {
                return if this.ShouldPromoteToNullableReference(conversionOperator) ||
                    this
                    .IsTranslatorWidenedDeclaration(conversionOperator) {
                    conversionOperator.ReturnType.WithNullableAnnotation(
                        Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                    )
                } else {
                    conversionOperator.ReturnType
                }
            }
            let typeInfo = this.context.GetTypeInfo(current)
            if typeInfo.Type != nil {
                return typeInfo.Type
            }
            if current.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression) {
                return typeInfo.ConvertedType
            }
            let hasCallableParameters = !(
                current is AnonymousMethodExpressionSyntax anonymousMethod && anonymousMethod.ParameterList == nil
            )
            if hasCallableParameters && this.context.GetSymbolInfo(current).Symbol is IMethodSymbol callableMethod {
                return this.ConstructDelegateFromCallableMethod(
                    typeInfo.ConvertedType,
                    callableMethod,
                    includeReturn: !(current is AnonymousFunctionExpressionSyntax)
                )
            }
            return nil
        }

        private func LowersNullArgumentToTypedDefault(argument ArgumentSyntax, targetParameter IParameterSymbol?) bool {
            let targetType ITypeSymbol? = targetParameter?.Type
            if targetParameter == nil ||
                targetType == nil ||
                !IsNullOrSuppressedNull(argument.Expression) ||
                !targetType.IsReferenceType ||
                targetParameter
                .OriginalDefinition
                .Type is ITypeParameterSymbol {
                return false
            }
            if targetParameter
                .ContainingAssembly
                ?.Name != "Gsharp.Runtime.Values" &&
                !ContainsTypeParameter(targetParameter.OriginalDefinition.Type) {
                return false
            }
            let targetIsPromotedMigratedSibling = !SymbolEqualityComparer.Default.Equals(
                targetParameter.ContainingAssembly,
                this.context.Compilation.Assembly
            ) &&
                targetParameter
                .ContainingAssembly
                ?.Name is {} targetAssemblyName &&
                targetAssemblyName != this
                .context
                .Compilation
                .AssemblyName &&
                (this.context.RepositoryCompilations ?? this.context.SiblingCompilations)?.Any(
                (compilation CSharpCompilation) -> compilation.AssemblyName == targetAssemblyName
            ) == true &&
                this.ShouldPromoteToNullableReference(targetParameter)
            return !targetIsPromotedMigratedSibling && !this.IsObliviousImportedInferredTypeParameterTarget(
                targetParameter,
                argument.Expression
            ) &&
                this.TargetWillRemainNonNullableReference(targetType, targetParameter, argument.Expression)
        }

        private func ConstructDelegateFromCallableMethod(
            convertedType ITypeSymbol?,
            callableMethod IMethodSymbol,
            includeReturn bool
        ) ITypeSymbol? {
            if convertedType is not INamedTypeSymbol named {
                return convertedType
            }
            if named.TypeKind == TypeKind.Delegate &&
                named
                .OriginalDefinition
                .DelegateInvokeMethod is {} invokeDefinition {
                let definition = named.OriginalDefinition
                if definition
                    .TypeParameters
                    .Length == 0 ||
                    callableMethod
                    .Parameters
                    .Length != invokeDefinition
                    .Parameters
                    .Length {
                    return named
                }
                let bindings = Dictionary[ITypeParameterSymbol, ITypeSymbol](SymbolEqualityComparer.Default)
                for var i = 0; i < invokeDefinition.Parameters.Length; i++ {
                    let parameterSymbol = callableMethod.Parameters[i]
                    let isPromotedParameter = if callableMethod.MethodKind == MethodKind.AnonymousFunction {
                        this.IsTranslatorWidenedDeclaration(parameterSymbol)
                    } else {
                        this.ShouldPromoteToNullableReference(parameterSymbol) || this.IsTranslatorWidenedDeclaration(
                            parameterSymbol
                        )
                    }
                    let parameterType = if isPromotedParameter {
                        parameterSymbol.Type.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
                    } else {
                        parameterSymbol.Type
                    }
                    let parameterVariance = if invokeDefinition.Parameters[i].RefKind != RefKind.None {
                        VarianceKind.None
                    } else {
                        VarianceKind.In
                    }
                    BindCallableTypeParameters(
                        invokeDefinition.Parameters[i].Type,
                        parameterType,
                        parameterVariance,
                        bindings,
                        this.context.Compilation
                    )
                }
                if includeReturn && !invokeDefinition.ReturnsVoid {
                    let returnType = if this.ShouldPromoteToNullableReference(callableMethod) ||
                        this
                        .IsTranslatorWidenedDeclaration(callableMethod) {
                        callableMethod.ReturnType.WithNullableAnnotation(
                            Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                        )
                    } else {
                        callableMethod.ReturnType
                    }
                    let returnVariance = if invokeDefinition.ReturnsByRef || invokeDefinition.ReturnsByRefReadonly {
                        VarianceKind.None
                    } else {
                        VarianceKind.Out
                    }
                    BindCallableTypeParameters(
                        invokeDefinition.ReturnType,
                        returnType,
                        returnVariance,
                        bindings,
                        this.context.Compilation
                    )
                }
                let typeArguments = List[ITypeSymbol](definition.TypeParameters.Length)
                for var i = 0; i < definition.TypeParameters.Length; i++ {
                    typeArguments.Add(
                        if bindings.TryGetValue(definition.TypeParameters[i], out var bound) {
                            bound
                        } else {
                            named.TypeArguments[i]
                        }
                    )
                }
                return definition.Construct(typeArguments.ToArray())
            }
            return named
        }

        private func ShouldPromoteToNullableReference(symbol ISymbol?, checkRefStorage bool = true) bool {
            let declared ITypeSymbol? = PromotableDeclaredType(symbol)
            if !(declared != nil && declared.IsReferenceType == true) ||
                declared.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            // Issue #5601: the answer is about the declaration the translator
            // emits, and it emits the original definition. A member of a
            // constructed type or method (`Box<Node>.Value`) is promoted only if
            // its original declaration can be: a slot typed by a type parameter
            // that is not constrained to a class (`T Value`) stays `T`, whatever
            // reference type the type argument substitutes, so a maybe-null
            // value stored into it keeps its bridge.
            if PromotableDeclaredType(symbol?.OriginalDefinition)?.IsReferenceType != true {
                return false
            }
            if checkRefStorage && this.TryGetRefStorageSlot(symbol, 0) is {} slot {
                return this.RefStorageIsNullable(slot, includeArrays: true)
            }
            if this.RefStorageContractIsFrozen(symbol, 0) {
                return false
            }
            // Issue #4356 follow-up: a field or property declared in ANOTHER
            // project of this migration is seen here through that project's
            // reference assembly (repository mode loads siblings as metadata),
            // so its declaration-side promotions — `[AllowNull]` below, the
            // #1072 usage scan — cannot be decided from this compilation. The
            // referenced project's own translation DID decide them and emitted
            // `T?`; ask the same questions of the declaring compilation so this
            // consumer's member chains get the `!!` gsc requires (GS0158).
            if this.DeclaringRepositoryMemberPromotes(symbol) {
                return true
            }
            // Issue #3694: C# gives a declaration two nullability contracts, an
            // INPUT and an OUTPUT one, and `[AllowNull]` keeps the output
            // non-nullable while widening the input — `[AllowNull] T P { get;
            // set; }` is exactly "the setter takes T?, the getter returns T",
            // the shape of a property whose setter normalises `null` to a
            // default. G# has a SINGLE nullability per declaration (ADR-0155,
            // Kotlin-style), so the only rendering that still accepts the
            // writes the C# accepts is `T?`; anything else turns a supported
            // assignment into an unrepresentable one (gsc GS0155 at the write —
            // and there is no `!!` for "assign nil to a non-nil target", so
            // there is nothing to bridge with at the use site).
            //
            // Being attribute-driven, this is decided by the DECLARATION alone:
            // no consumer evidence, no taint fixpoint, the same answer in every
            // compilation of a run. That is what makes it safe across projects,
            // where a consumer's promotion decision could otherwise disagree
            // with the contract the referenced project actually emitted.
            if ObliviousNullabilityAnalyzer.HasAllowNullWriteContract(symbol) {
                return true
            }
            // Issue #3726: a data-driving attribute is a null-WRITING site. An
            // xunit theory declared `[InlineData(null, …)] void T(string a, …)`
            // genuinely receives `null` for `a` at runtime, and cs2gs emits the
            // attribute — `@InlineData(nil, …)` — right beside the parameter
            // list it renders, so a non-nullable `a` contradicts the file's own
            // attribute (gsc GS0274). Attribute-driven and therefore decided by
            // the DECLARATION alone, exactly like `[AllowNull]` above.
            if ObliviousNullabilityAnalyzer.HasNullDataRowArgument(symbol) {
                return true
            }
            // Issue #5508: a call that passes the author's own `null` / `null!`
            // into a parameter the C# declares non-nullable — and the slots that
            // parameter's value reaches unchanged — is decided by that evidence,
            // not by the annotation `!` was written to silence. Direct evidence
            // and pure forwarding only, decided by the DECLARATION across every
            // compilation of the run (see `IsNullArgumentTarget`).
            if ObliviousNullabilityAnalyzer.IsNullArgumentTarget(
                this.context.Compilation,
                NormalizePositionalRecordProperty(symbol),
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) {
                return true
            }
            // EF Core treats reference properties from nullable-oblivious C#
            // entity types as optional. Preserve that model when translating
            // DbSet<T> entities; emitting a non-nullable G# property would make
            // EF materialize nullable database columns with GetString instead
            // of honoring DBNull.
            if this.IsObliviousCompilation() && symbol is IPropertySymbol property && this.efEntityTypes.Contains(
                property.ContainingType.OriginalDefinition
            ) {
                return true
            }
            // A function-type (delegate) parameter with an explicit `= null`
            // default is nullable by construction: a non-nullable function type
            // cannot carry a `nil` default at all (gsc GS0265 at the declaration
            // itself), so it must render `((…) -> R)?`. This is scoped to delegate
            // types because promoting arbitrary reference parameters cascades
            // nullable-mismatch errors (GS0156) at pass-through call sites that
            // would each need their own flow-driven promotion.
            if symbol is IParameterSymbol parameter &&
                EffectiveDefaultParameter(parameter) is {HasExplicitDefaultValue: true} defaulted &&
                defaulted.ExplicitDefaultValue == nil &&
                defaulted
                .Type
                .TypeKind == TypeKind.Delegate {
                return true
            }
            // Issue #2113: in a nullable-OBLIVIOUS compilation, a reference
            // declaration is rendered `T?` iff the whole-program transitive
            // null-taint analysis proved this symbol null-tainted. This is the
            // ONLY behavioral change for oblivious code. Issue #4262 widened
            // `IsTainted`'s entry gate to also answer for a nullable-ENABLED
            // asking compilation when a SIBLING is oblivious, but the
            // `declared.NullableAnnotation == NullableAnnotation.None` guard
            // immediately below still keeps every enabled-compilation path
            // byte-identical: an enabled declaration's own annotation is
            // `NotAnnotated`/`Annotated`, never `None`, so this branch is
            // unreachable for it regardless of what `IsTainted` would answer.
            //
            // Issue #914 (oblivious deferred-return-promotion): a REFERENCE-
            // constrained type parameter (`where T : class`) is eligible too. The
            // top-of-method guard already required `declared.IsReferenceType`, so
            // an UNCONSTRAINED `T` (whose `IsReferenceType` is false, and for whom
            // `T?` would mean `Nullable<T>`) never reaches here. For a class-
            // constrained `T`, `T?` is an unambiguous nullable reference — the
            // generated `var settings T? = …` locals already rely on it — and
            // `Cast[T]`/`typeof(T)`/`T()` NAME positions are unaffected because
            // they reference `T`, not the promoted symbol.
            //
            // Issue #2412: the taint fixpoint only walks ONE compilation's own
            // syntax trees, so a symbol whose ONLY tainting evidence lives in a
            // REFERENCED sibling project (loaded as its own separate
            // `CSharpCompilation` by `CSharpProjectLoader.
            // LoadProjectWithReferencesAsync`) — whether the symbol is declared
            // there directly, or is declared here/in a third project but only
            // gets wired into taint via a sibling's own interface-implementation
            // edges (issue #2285) — must also be checked against every sibling's
            // OWN cached result, not just `this.context.Compilation`'s (the
            // downstream consumer's translation unit, whose syntax never
            // contains that evidence). `this.context.SiblingCompilations` is
            // `null` for every existing single-compilation caller, so this
            // overload reduces to the exact prior single-compilation check —
            // a pure additive fix for the cross-project case.
            // Issue #3501: a symbol declared in a SHARED document (a source
            // file linked into several repo projects, e.g. test/Shared/*) must
            // translate identically in every project — the repository mirror
            // rejects divergent outputs. Its taint check therefore runs over
            // the whole repository's compilations, and the per-project
            // usage-driven fallback below is skipped for it.
            let sharedDocument = this.IsDeclaredInRepositorySharedDocument(symbol)
            let taintCompilations IReadOnlyList[CSharpCompilation]? = if IsStoredMemberNullabilitySymbol(symbol) ||
                sharedDocument {
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            } else {
                this.context.SiblingCompilations
            }
            // Issue #3501: a positional record's synthesized property and its
            // primary-constructor parameter are ONE declaration site (the same
            // ParameterSyntax) but TWO Roslyn symbols. The taint fixpoint keys
            // argument edges on the parameter (`new Entry(null, …)`), while a
            // member read (`entry.GsNamespace`) binds the property — query the
            // parameter's taint for such a property so the value bridge and the
            // promoted declaration agree.
            if PartialCounterpart(symbol) is {} counterpart && PromotableDeclaredType(
                counterpart
            )?.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return true
            }
            if declared.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .None &&
                PartialPartnerAllowsObliviousPromotion(symbol) &&
                ObliviousNullabilityAnalyzer
                .IsTainted(this.context.Compilation, NormalizePositionalRecordProperty(symbol), taintCompilations) {
                return true
            }
            // Issue #3676: a declaration inside an `<auto-generated/>` file is
            // nullable when the code directly writes `null` into it. The C#
            // compiler reports NO nullable diagnostics in generated code, so
            // such a declaration's `NotAnnotated` reference type was never
            // checked against the code that assigns or returns it — LSP
            // protocol plumbing marked generated (for StyleCop, not because it
            // is machine-written) freely writes `Filter = null` into a
            // `string Filter` and `return null` from a `string` method.
            // Translating those annotations at face value emits G# the C#
            // compiler never had to justify, and gsc — which has no such
            // suppression — rejects the `nil` (GS0155).
            if ObliviousNullabilityAnalyzer.IsGeneratedDeclarationAssignedNull(
                this.context.Compilation,
                symbol,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) {
                return true
            }
            // Issue #3848: the promotion above stops at the generated
            // declaration itself, and a hand-authored method that does nothing
            // but hand that declaration's value back — `GetDocumentUri`, whose
            // every `return` is `DocumentUri.From(fallback)` /
            // `DocumentUri.FromFileSystemPath(…)`, both generated and both
            // promoted — loses it again, so the forgiveness pass bridges the
            // gap with a `!!` that THROWS on the null the C# happily returned.
            // `IsPromotedByPureForwarding` carries the promotion along that
            // edge, and along the write of the forwarded value into a
            // GENERATED sink (`Location.Uri`) so the `!!` does not simply move
            // one frame up. Its doc comment states the edge exactly; the
            // clauses are narrow because everything they exclude — a local, a
            // conditional arm, a `??` — is a place the value could have been
            // changed, and a hand-authored non-generated sink keeps its
            // annotation and its `!!` because the C# compiler actually checked
            // that write.
            if ObliviousNullabilityAnalyzer.IsPromotedByPureForwarding(
                this.context.Compilation,
                symbol,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) {
                return true
            }
            return !sharedDocument && !(symbol is IMethodSymbol) && this.IsUsedAsNullable(
                symbol,
                this.GetNullabilityScope(symbol)
            )
        }

        private func RefStorageDestination(reference RefExpressionSyntax, model SemanticModel) ISymbol? {
            let symbol = if reference.Parent is EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declaration} {
                model.GetDeclaredSymbol(declaration)
            } else if reference.Parent is ReturnStatementSyntax or ArrowExpressionClauseSyntax {
                model.GetEnclosingSymbol(reference.SpanStart)
            } else {
                default(ISymbol?)
            }
            let normalized = if symbol is IMethodSymbol{AssociatedSymbol: IPropertySymbol property} {
                cast[ISymbol](property)
            } else {
                symbol
            }
            return if ObliviousNullabilityAnalyzer.IsRefStorageSymbol(normalized) {
                normalized?.OriginalDefinition
            } else {
                default(ISymbol?)
            }
        }

        private func GetRefStorageSlot(symbol ISymbol, depth int32) RefStorageSlot {
            let identity = RefStorageIdentity(symbol)
            let slots = this.refStorageSlots!!
            if !slots.TryGetValue(identity, out var positions) {
                positions = Dictionary[int32, RefStorageSlot]()
                slots.Add(identity, positions)
            }
            if !positions.TryGetValue(depth, out var slot) {
                slot = RefStorageSlot(identity, depth)
                positions.Add(depth, slot)
            }
            return slot
        }

        private func ConnectRefStorage(target RefStorageSlot, expression ExpressionSyntax, model SemanticModel) {
            let storage = UnwrapParenthesesAndSuppressions(expression)!!
            if storage is RefExpressionSyntax nested {
                this.ConnectRefStorage(target, nested.Expression, model)
                return
            }
            if storage is ConditionalExpressionSyntax conditional {
                this.ConnectRefStorage(target, conditional.WhenTrue, model)
                this.ConnectRefStorage(target, conditional.WhenFalse, model)
                return
            }
            var receiver ExpressionSyntax = storage
            var depth = 0
            while receiver is ElementAccessExpressionSyntax access && model.GetTypeInfo(access.Expression)
                .Type is IArrayTypeSymbol {
                depth++
                receiver = UnwrapParenthesesAndSuppressions(access.Expression)!!
            }
            var source = if receiver is DeclarationExpressionSyntax{
                Designation: SingleVariableDesignationSyntax designation
            } {
                model.GetDeclaredSymbol(designation)
            } else {
                model.GetSymbolInfo(receiver).Symbol
            }
            if source is IMethodSymbol{AssociatedSymbol: IPropertySymbol property} {
                source = property
            }
            if source == nil || source is IDiscardSymbol {
                return
            }
            if receiver is InvocationExpressionSyntax{
                Expression: MemberAccessExpressionSyntax{Name: IdentifierNameSyntax} access
            } &&
                model
                .GetTypeInfo(access.Expression).Type is INamedTypeSymbol receiverType {
                source = this.RefStorageIdentity(source, receiverType)
            }
            if depth > 0 {
                source = this.GetArrayStorageOwner(
                    source,
                    HashSet[ISymbol](SymbolEqualityComparer.Default),
                    preserveSubstitution: true
                ) ??
                    source
            }
            this.JoinRefStorageSlots(target, this.GetRefStorageSlot(source!!, depth))
            var type = this.RefStorageSlotType(target)
            var nestedDepth = 0
            while type is IArrayTypeSymbol array {
                nestedDepth++
                this.JoinRefStorageSlots(
                    this.GetRefStorageSlot(target.Symbol, target.Depth + nestedDepth),
                    this.GetRefStorageSlot(source!!, depth + nestedDepth)
                )
                type = array.ElementType
            }
        }

        private func JoinRefStorageSlots(first RefStorageSlot, second RefStorageSlot) {
            let left = first.Root()
            let right = second.Root()
            if object.ReferenceEquals(left, right) {
                return
            }
            let larger = if left.Members.Count >= right.Members.Count {
                left
            } else {
                right
            }
            let smaller = if object.ReferenceEquals(larger, left) {
                right
            } else {
                left
            }
            smaller.Parent = larger
            larger.Members.AddRange(smaller.Members)
            smaller.Members.Clear()
        }

        private func EnsureRefStorageSlots() {
            if this.refStorageSlots != nil {
                return
            }
            this.refStorageSlots = Dictionary[ISymbol, Dictionary[int32, RefStorageSlot]](
                SymbolEqualityComparer.IncludeNullability
            )
            // Constructed slots retain nullable arguments. Declaration constraints use the original symbol.
            this.frozenRefStorageContracts = Dictionary[ISymbol, HashSet[int32]](SymbolEqualityComparer.Default)
            for tree in this.context.Compilation.SyntaxTrees {
                let model = this.context.Compilation.GetSemanticModel(tree)
                using let modelScope = this.context.UseSemanticModelFor(tree)
                for reference in tree.GetRoot().DescendantNodes().OfType[RefExpressionSyntax]() {
                    if this.RefStorageDestination(reference, model) is {} destination {
                        this.ConnectRefStorage(this.GetRefStorageSlot(destination, 0), reference.Expression, model)
                    }
                }
                for argument in tree.GetRoot().DescendantNodes().OfType[ArgumentSyntax]() {
                    if (argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword)) && model.GetOperation(
                        argument
                    ) is IArgumentOperation{Parameter: {RefKind: RefKind.Ref} parameter} {
                        let storageType = ObliviousNullabilityAnalyzer.SymbolValueType(
                            model.GetSymbolInfo(argument.Expression).Symbol
                        ) ??
                            model
                            .GetTypeInfo(argument.Expression).Type
                        if storageType?.IsReferenceType == true &&
                            storageType?.NullableAnnotation == Microsoft
                            .CodeAnalysis
                            .NullableAnnotation
                            .Annotated &&
                            parameter
                            .Type
                            .NullableAnnotation == Microsoft
                            .CodeAnalysis
                            .NullableAnnotation
                            .NotAnnotated {
                            continue
                        }
                        this.ConnectRefStorage(this.GetRefStorageSlot(parameter, 0), argument.Expression, model)
                    }
                }
            }
            this.FreezeRefStorageContracts()
            this.ReconcileLinkedRefStorageContracts()
        }

        private func ReconcileLinkedRefStorageContracts() {
            if this.context.RepositoryCompilations is not{Count: > 1} repository {
                return
            }
            this.EnsureRepositorySharedDocumentPaths()
            if this.repositorySharedDocumentPaths!!.Count == 0 {
                return
            }
            let visitors = List[DeclarationVisitor](){this}
            for owner in repository {
                if owner == this.context.Compilation {
                    continue
                }
                let tree = owner.SyntaxTrees.FirstOrDefault(
                    (candidate SyntaxTree) -> this.repositorySharedDocumentPaths!!.Contains(candidate.FilePath)
                )
                if tree == nil {
                    continue
                }
                // Foreign visitors compute local constraints without repository recursion.
                let ownerContext = TranslationContext(owner, owner.GetSemanticModel(tree), tree.FilePath)
                let ownerVisitor = DeclarationVisitor(
                    ownerContext,
                    this.typeMapper,
                    subclassedBases: nil,
                    staticUsingTargets: nil,
                    entryPoint: nil,
                    keptTopLevelProgram: nil,
                    partialTypeParts: nil,
                    CSharpToGSharpTranslator.GetOrCollectOwnedExtensions(owner),
                    this.nameAllocator,
                    widenObliviousReferenceFields: this.widenObliviousReferenceFields
                )
                ownerVisitor.EnsureRefStorageSlots()
                visitors.Add(ownerVisitor)
            }
            var changed bool
            do {
                changed = false
                for source in visitors {
                    let promotions = Dictionary[ISymbol, HashSet[int32]](SymbolEqualityComparer.Default)
                    for slots in source.refStorageSlots!!.Values {
                        for slot in slots.Values {
                            if source.RefStoragePositionType(slot.Symbol.OriginalDefinition, slot.Depth)
                                ?.IsReferenceType != true {
                                continue
                            }
                            let tree = slot.Symbol.DeclaringSyntaxReferences.FirstOrDefault()?.SyntaxTree
                            if tree == nil || !source.context.Compilation.ContainsSyntaxTree(tree) {
                                continue
                            }
                            using let modelScope = source.context.UseSemanticModelFor(tree)
                            if source.RefStorageIsNullable(slot, includeArrays: true) {
                                if !promotions.TryGetValue(slot.Symbol.OriginalDefinition, out var positions) {
                                    positions = HashSet[int32]()
                                    promotions.Add(slot.Symbol.OriginalDefinition, positions)
                                }
                                positions.Add(slot.Depth)
                            }
                        }
                    }
                    let decisions = source.frozenRefStorageContracts!!
                        .Select(
                        (contract KeyValuePair[ISymbol, HashSet[int32]]) -> (
                            Symbol: contract.Key,
                            Positions: contract.Value,
                            Frozen: true
                        )
                    )
                        .Concat(
                        promotions.Select(
                            (promotion KeyValuePair[ISymbol, HashSet[int32]]) -> (
                                Symbol: promotion.Key,
                                Positions: promotion.Value,
                                Frozen: false
                            )
                        )
                    )
                        .ToList()
                    for contract in decisions {
                        for reference in contract.Symbol.DeclaringSyntaxReferences {
                            if !this.repositorySharedDocumentPaths!!.Contains(reference.SyntaxTree.FilePath) {
                                continue
                            }
                            let declaration = reference.GetSyntax()
                            for target in visitors {
                                if target == source {
                                    continue
                                }
                                let tree = target
                                    .context
                                    .Compilation
                                    .SyntaxTrees
                                    .FirstOrDefault(
                                    (candidate SyntaxTree) -> string.Equals(
                                        candidate.FilePath,
                                        reference.SyntaxTree.FilePath,
                                        StringComparison.OrdinalIgnoreCase
                                    )
                                )
                                if tree == nil || tree.GetRoot().FullSpan.End < reference.Span.End {
                                    continue
                                }
                                let node = tree.GetRoot().FindNode(reference.Span)
                                if node.RawKind != declaration.RawKind || node.ToString() != declaration.ToString() {
                                    continue
                                }
                                let symbol = target
                                    .context
                                    .Compilation
                                    .GetSemanticModel(tree)
                                    .GetDeclaredSymbol(node)
                                    ?.OriginalDefinition
                                if symbol == nil {
                                    continue
                                }
                                let decisions = if contract.Frozen {
                                    target.frozenRefStorageContracts!!
                                } else {
                                    target.linkedRefStoragePromotions
                                }
                                if !decisions.TryGetValue(symbol, out var positions) {
                                    positions = HashSet[int32]()
                                    decisions.Add(symbol, positions)
                                }
                                for depth in contract.Positions {
                                    changed |= positions.Add(depth)
                                    if !contract.Frozen {
                                        target.GetRefStorageSlot(symbol, depth)
                                    }
                                }
                            }
                        }
                    }
                }
                for visitor in visitors {
                    visitor.FreezeRefStorageContracts()
                }
            } while changed
        }

        private func TryGetRefStorageSlot(symbol ISymbol?, depth int32) RefStorageSlot? {
            if symbol == nil {
                return nil
            }
            this.EnsureRefStorageSlots()
            return if this.refStorageSlots!!.TryGetValue(RefStorageIdentity(symbol), out var positions) &&
                positions.TryGetValue(depth, out var slot) {
                slot
            } else {
                default(RefStorageSlot?)
            }
        }

        private func RefStoragePositionType(symbol ISymbol, position int32) ITypeSymbol? {
            var type = ObliviousNullabilityAnalyzer.SymbolValueType(symbol)
            for var depth = 0; depth < position; depth++ {
                type = (type as IArrayTypeSymbol)?.ElementType
            }
            return type
        }

        private func RefStorageSlotType(slot RefStorageSlot) ITypeSymbol? ->
        this.RefStoragePositionType(slot.Symbol, slot.Depth)

        private func RefStorageIdentity(symbol ISymbol, receiver INamedTypeSymbol? = nil) ISymbol {
            if symbol is IMethodSymbol{ReducedFrom: {} original} method {
                if method.IsGenericMethod {
                    let arguments = Enumerable
                        .Range(0, method.Arity)
                        .Select((index int32) -> this.GetEffectiveMethodTypeArgument(method, index))
                        .ToArray()
                    let definition = original.ConstructedFrom
                    if receiver != nil {
                        for var index = 0; index < arguments.Length; index++ {
                            if this.TryGetProjectedTypeArgument(
                                definition.Parameters[0].Type,
                                receiver,
                                definition.TypeParameters[index],
                                this.context.Compilation,
                                out var inferred,
                                out var conflict,
                                includeAllArguments: true
                            ) &&
                                !conflict &&
                                inferred != nil &&
                                !(
                                inferred.NullableAnnotation == Microsoft
                                    .CodeAnalysis
                                    .NullableAnnotation
                                    .Annotated &&
                                    NullableTypeArgumentViolatesTranslatedConstraints(definition.TypeParameters[index])
                            ) {
                                arguments[index] = inferred
                            }
                        }
                    }
                    return original.ConstructedFrom.Construct(
                        arguments.ToImmutableArray(),
                        arguments.Select((argument ITypeSymbol) -> argument.NullableAnnotation).ToImmutableArray()
                    )
                }
                return original
            }
            return symbol
        }

        private func RefStorageContractIsFrozen(symbol ISymbol?, depth int32) bool -> symbol != nil &&
            this
            .frozenRefStorageContracts
            ?.TryGetValue(RefStorageIdentity(symbol).OriginalDefinition, out var positions) == true &&
            positions.Contains(depth)

        private func RefStorageSlotIsFixed(slot RefStorageSlot) bool {
            let type = this.RefStorageSlotType(slot)
            // A nullable substitution already admits nil. Freezing prevents only new nullable layers.
            if type?.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
                return false
            }
            if this.RefStorageContractIsFrozen(slot.Symbol, slot.Depth) || this.RefStoragePositionType(
                slot.Symbol.OriginalDefinition,
                slot.Depth
            )
                ?.IsReferenceType != true {
                return true
            }
            if type?.NullableAnnotation != Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated {
                return false
            }
            if slot.Depth == 0 {
                return !this.ShouldPromoteToNullableReference(slot.Symbol, checkRefStorage: false)
            }
            if slot.Symbol is ILocalSymbol local &&
                local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{
                Parent: VariableDeclarationSyntax{Type: {IsVar: true}}
            } declaration &&
                !this
                .context
                .Compilation
                .GetSemanticModel(declaration.SyntaxTree)
                .GetNullableContext(declaration.SpanStart)
                .HasFlag(NullableContext.AnnotationsEnabled) {
                return false
            }
            return !(slot.Depth == 1 && this.IsGeneratedArrayElementPromotedSink(slot.Symbol)) &&
                !this
                .IsWidenedArrayElementStorageCore(
                slot.Symbol,
                string.Join(".", Enumerable.Repeat("0", slot.Depth)),
                checkRefStorage: false
            )
        }

        private func FreezeRefStorageContracts() {
            // A fixed argument can freeze the generic declaration before any document emits it.
            let roots = this.refStorageSlots!!
                .Values
                .SelectMany((positions Dictionary[int32, RefStorageSlot]) -> positions.Values)
                .Select((slot RefStorageSlot) -> slot.Root())
                .Distinct()
                .ToList()
            var changed bool
            do {
                changed = false
                for root in roots {
                    root.EvaluatingArrays = true
                    var fixedContract bool
                    try {
                        fixedContract = root.Members.Any(this.RefStorageSlotIsFixed)
                    } finally {
                        root.EvaluatingArrays = false
                    }
                    if !fixedContract {
                        continue
                    }
                    for member in root.Members {
                        let symbol = member.Symbol.OriginalDefinition
                        if !this.frozenRefStorageContracts!!.TryGetValue(symbol, out var positions) {
                            positions = HashSet[int32]()
                            this.frozenRefStorageContracts!!.Add(symbol, positions)
                        }
                        changed |= positions.Add(member.Depth)
                    }
                }
            } while changed
        }

        private func RefStorageIsNullable(slot RefStorageSlot, includeArrays bool) bool {
            let root = slot.Root()
            if root.EvaluatingArrays {
                return false
            }
            // A cycle adds no evidence. Keep searching its other array and scalar sources.
            root.EvaluatingArrays = true
            try {
                if root.Members.Any(this.RefStorageSlotIsFixed) {
                    return false
                }
                for member in root.Members {
                    if this.linkedRefStoragePromotions.TryGetValue(
                        member.Symbol.OriginalDefinition,
                        out var positions
                    ) &&
                        positions.Contains(member.Depth) || this.RefStorageSlotType(member)?.NullableAnnotation ==
                    Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated ||
                        (
                        member.Depth == 0 && this.ShouldPromoteToNullableReference(
                            member.Symbol,
                            checkRefStorage: false
                        )
                    ) {
                        return true
                    }
                }
                if includeArrays {
                    for member in root.Members {
                        if member.Depth > 0 && this.IsWidenedArrayElementStorage(
                            member.Symbol,
                            string.Join(".", Enumerable.Repeat("0", member.Depth))
                        ) {
                            return true
                        }
                    }
                }
                return false
            } finally {
                root.EvaluatingArrays = false
            }
        }

        private func RefStorageArrayIsNullable(symbol ISymbol, position string) bool {
            if this.TryGetRefStorageSlot(symbol, position.Split('.').Length) is {} slot {
                return this.RefStorageIsNullable(slot, includeArrays: false)
            }
            return false
        }

        // Issue #3501: file paths that appear in MORE THAN ONE repository
        // compilation — linked/shared sources whose translation must not
        // depend on which project is being translated.
        private func IsDeclaredInRepositorySharedDocument(symbol ISymbol?) bool {
            if this.context.RepositoryCompilations is not{Count: > 1} {
                return false
            }
            this.EnsureRepositorySharedDocumentPaths()
            for reference in symbol!!.DeclaringSyntaxReferences {
                let path string? = reference.SyntaxTree?.FilePath
                if !string.IsNullOrEmpty(path) && this.repositorySharedDocumentPaths!!.Contains(path!!) {
                    return true
                }
            }
            return false
        }

        private func EnsureRepositorySharedDocumentPaths() {
            if this.repositorySharedDocumentPaths == nil {
                let counts = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase)
                for compilation in this.context.RepositoryCompilations ?? Array.Empty[CSharpCompilation]() {
                    for tree in compilation.SyntaxTrees {
                        if !string.IsNullOrEmpty(tree.FilePath) {
                            counts[tree.FilePath] = if counts.TryGetValue(tree.FilePath, out var n) {
                                n + 1
                            } else {
                                1
                            }
                        }
                    }
                }
                this.repositorySharedDocumentPaths = counts
                    .Where((kv KeyValuePair[string, int32]) -> kv.Value > 1)
                    .Select((kv KeyValuePair[string, int32]) -> kv.Key)
                    .ToHashSet(StringComparer.OrdinalIgnoreCase)
            }
        }

        // Issue #2521: sink lowering must use the target contract that G# will
        // actually bind, not consumer-side taint recorded for an imported
        // symbol. Only declarations emitted by this compilation can have their
        // contract widened by this compilation's promotion result. Project
        // references and CLR metadata retain their already-emitted contract.
        private func TargetWillRemainNonNullableReference(
            targetType ITypeSymbol?,
            targetSymbol ISymbol?,
            writtenValue ExpressionSyntax? = nil
        ) bool {
            if !(targetType != nil && targetType.IsReferenceType == true) ||
                targetType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            // Issue #5537: a parameter or element typed by a type argument of oblivious
            // container storage, or of a construction stored there, takes that argument's
            // nullable spelling (`List[string?].Add`, `[]string?` elements).
            if this.WritesObliviousContainerStorageElement(writtenValue) {
                return false
            }
            // ADR-0169 analyzer mode: an INamespaceSymbol target renders as
            // G#'s namespace display string, which the mapper forces to
            // `string?` (see CSharpTypeMapper.Map) — Roslyn's non-nullable
            // annotation on the C# side is not honored by the G# surface, so
            // the target never remains non-nullable and nullable arguments
            // need no `!!` bridge.
            if this.InAnalyzerApiMode && RoslynAnalyzerApiMap.IsNamespaceSymbolType(targetType) {
                return false
            }
            // Issue #3694: an `[AllowNull]` target is promoted from its own
            // declaration, so it widens in the project that emits it whether or
            // not that project is the one being translated here. Unlike the
            // evidence-driven promotions below, this one needs no
            // same-compilation gate — the referenced project's migrated
            // declaration is nullable too, so a nullable value needs no bridge.
            // Issue #5577: a target seen through a run project's emitted
            // reference is read from its source declaration, with the query the
            // null-argument pin rule uses.
            if ObliviousNullabilityAnalyzer.HasRunAllowNullWriteContract(
                targetSymbol,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) {
                return false
            }
            // Issue #3865: an IMPORTED target with no nullable metadata at all
            // is oblivious, and gsc's import rule is the INVERSE of C#'s —
            // `ClrNullability.IsPositionNonNull` reads "non-null iff the byte is
            // 1", so oblivious AND absent metadata both map to `T?`. The
            // imported parameter/field therefore already accepts a nullable
            // value and no `!!` bridge is needed. This is the write-side mirror
            // of the read-side rule `IsImportedObliviousNullableMember` has
            // applied since issue #2113.
            //
            // ADR-0186 step 3 changed gsc's reading of such a target from `T?`
            // to the platform type `T!`. The answer here is unchanged: `T? → T!`
            // is an identity conversion (§3), so a nullable value still needs
            // no bridge.
            //
            // Getting this backwards is not a readability wart: `x!!` is a
            // RUNTIME assertion in G# (it lowers to `dup; brtrue; pop; newobj
            // NullReferenceException; throw`), unlike C#'s erased `x!`, so a
            // gratuitous assertion on a legitimately-null argument turns a legal
            // C# call into a crash that translate, compile and ILVerify all pass.
            if this.IsImportedObliviousNullableTarget(targetSymbol, targetType, writtenValue) {
                return false
            }
            // Issue #3886: the DECLARATION side deliberately never promotes a
            // variadic carrier — `TranslateParameter` gates promotion on
            // `!variadic` because "variadic params are never null-compared as a
            // whole" — so a `params T[]` parameter is always emitted `...T`,
            // whatever null evidence (`if (paths is null) throw`, a body
            // `paths == null` guard) the fixpoint recorded against it. Asking
            // `ShouldPromoteToNullableReference` about that parameter HERE
            // therefore reports a widening that the emitted G# signature does
            // not have, and the sink-contract check silently suppresses the
            // `!!` bridge every nullable argument to it needs. That is exactly
            // the migrated test/Compiler.Tests wall: `EmittedFixture.
            // LoadTogether(params string[] assemblyPaths)` opens with
            // `if (assemblyPaths is null) throw`, so every expanded call site
            // passing a promoted `string?` lost its bridge and produced GS0154
            // (plus, in that file, fifteen cascade "cannot find function"
            // errors on the error-typed result).
            //
            // Mirror the declaration rule: a variadic carrier's contract is
            // whatever its own annotation says, never a promoted one. Issue
            // #3888 adds one deliberately separate exception: when this query
            // is for the expanded ELEMENT position and that position's own
            // evidence widened `...T` to `...T?`, no bridge is needed.
            //
            // Issue #4128: that exception must carry the same-run gate the
            // ordinary-parameter tail below already applies. #3888's evidence
            // is a PREDICTION about the `...T?` this run will emit, and
            // `IsParamsElementTainted` keys its edges on the owning method's
            // documentation-comment ID, which an imported declaration has too
            // — so a call site here passing a promoted `T?` taints the element
            // position of `System.Type.MakeGenericType(params Type[])` itself,
            // and the prediction then suppresses the very bridge that argument
            // needs. That is circular for a frozen target: gsc imports the BCL
            // carrier as `...Type` from its nullable metadata and nothing this
            // translator decides can widen it, so the migrated
            // test/Core.Tests `openTask.MakeGenericType(element)` lost its `!!`
            // and produced GS0155. Trust the widening only where this run
            // actually emits the declaration.
            if IsVariadicCarrierParameter(targetSymbol) {
                // Issue #5537: the shared storage rule spells the element of a
                // `params` parameter that receives oblivious container storage
                // `T?`, so an expanded nullable argument needs no bridge.
                if targetSymbol is IParameterSymbol promotedParameter && SymbolEqualityComparer.Default.Equals(
                    targetType,
                    GetParamsElementType(promotedParameter)
                ) &&
                    this.ObliviousParamsElementIsPromoted(promotedParameter) {
                    return false
                }
                return !(targetSymbol is IParameterSymbol{Type: IArrayTypeSymbol array} paramsParameter) ||
                    (paramsParameter.OriginalDefinition.Type as IArrayTypeSymbol)
                    ?.ElementType
                    .IsReferenceType != true ||
                    !SymbolEqualityComparer
                    .Default
                    .Equals(targetType, array.ElementType) || this.TargetContractIsFrozenInMetadata(paramsParameter) ||
                    !ObliviousNullabilityAnalyzer
                    .IsParamsElementTainted(
                    this.context.Compilation,
                    paramsParameter,
                    this.context.RepositoryCompilations ?? this.context.SiblingCompilations
                )
            }
            let targetDeclaredInThisCompilation = targetSymbol?.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> this.context.Compilation.ContainsSyntaxTree(reference.SyntaxTree)
            ) == true ||
                (
                targetSymbol is IFieldSymbol{AssociatedSymbol: {} associatedSymbol} &&
                    associatedSymbol
                    .DeclaringSyntaxReferences
                    .Any(
                    (reference SyntaxReference) -> this.context.Compilation.ContainsSyntaxTree(reference.SyntaxTree)
                )
            )
            // Issue #5508: a member another project of THIS run emits, seen here
            // through that project's reference assembly, carries the widening the
            // producer decided from the same run-wide evidence.
            if !targetDeclaredInThisCompilation && ObliviousNullabilityAnalyzer.IsNullArgumentTarget(
                this.context.Compilation,
                targetSymbol,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            ) {
                return false
            }
            return !(targetDeclaredInThisCompilation && this.IsTranslatorWidenedDeclaration(targetSymbol))
        }

        private func CoalesceAssignmentTargetIsNonNullInGSharp(assignment AssignmentExpressionSyntax) bool {
            let left ExpressionSyntax? = Unparenthesize(assignment.Left)
            if left == nil || left is ElementAccessExpressionSyntax {
                return false
            }
            let target ISymbol? = this.GetProjectedAssignmentTarget(left, this.context.GetSymbolInfo(left).Symbol)
            if target is ILocalSymbol local &&
                this
                .state
                .EmittedLocalStorageAcceptsNil
                .TryGetValue(local, out var acceptsNil) {
                return !acceptsNil
            }
            return this.AssignmentResultHasNonNullStaticType(assignment)
        }

        // Issue #4843: whether <paramref name="parameter"/> is declared as one of
        // an IMPORTED, OBLIVIOUS method's own type parameters
        // (`DecodeSignature<TType, TGenericContext>(provider, TGenericContext
        // genericContext)`), on a call whose type arguments are inferred, and
        // that type parameter does not appear in the method's return type.
        // gsc reads such a position as a platform type: the argument is not
        // checked against Roslyn's substituted `object`, and no result carries
        // the inferred argument onward. A `T?` value therefore needs no bridge,
        // and a runtime `!!` would turn a legal C# null forward into a
        // NullReferenceException (the migrated test/Core.Tests
        // CorePublicApiSnapshotTests). Everything else keeps its bridge: an
        // annotated method (`Assert.Contains<T>`), an explicit type argument
        // (`Identity<SyntaxNode>(x)`), a type parameter the result depends on
        // (`List<string> names = Wrap(x)`), and a CLASS type parameter
        // (`List<string>.Add(T)`), which the receiver fixes before the
        // argument is seen. A constrained type parameter and a reduced
        // extension invocation (whose `this` receiver is not in the parameter
        // list) keep their bridge: gsc would reject a nullable type argument
        // against the constraint, and the receiver's variance goes unexamined.
        private func IsObliviousImportedInferredTypeParameterTarget(
            parameter IParameterSymbol,
            argumentExpression ExpressionSyntax
        ) bool {
            let original = parameter.OriginalDefinition
            let declared = if this.IsExpandedParamsArgument(argumentExpression, parameter) {
                GetParamsElementType(original) ?? original.Type
            } else {
                original.Type
            }
            if !(declared is ITypeParameterSymbol typeParameter) ||
                typeParameter.TypeParameterKind != TypeParameterKind.Method ||
                original.ContainingSymbol is not IMethodSymbol method ||
                method.ReducedFrom != nil ||
                typeParameter.HasReferenceTypeConstraint ||
                typeParameter.HasValueTypeConstraint ||
                typeParameter.HasNotNullConstraint ||
                typeParameter.HasConstructorConstraint ||
                typeParameter
                .ConstraintTypes
                .Length > 0 ||
                !this.IsInferredGenericParameterTarget(parameter, argumentExpression) ||
                !this.TargetContractIsFrozenInMetadata(parameter) {
                return false
            }
            // The inferred argument must not reach a result, and every other
            // parameter that mentions it may do so only through an INVARIANT
            // type argument: there the argument itself (`this` as an
            // `ISignatureTypeProvider<string, object>`) fixes the type
            // argument. A covariant or array position (`Assert.Contains<T>(T,
            // IEnumerable<T>)`) lets the value widen the element instead, so
            // those keep their bridge.
            return !MentionsTypeParameter(method.ReturnType, typeParameter) && method.Parameters.All(
                (other IParameterSymbol) -> SymbolEqualityComparer.Default.Equals(other, original) ||
                    !MentionsTypeParameter(other.Type, typeParameter) ||
                    MentionsTypeParameterOnlyInvariantly(other.Type, typeParameter)
            )
        }

        // Issue #3865: true when <paramref name="targetSymbol"/> is a WRITE sink
        // (parameter, field or property) that exists only as CLR metadata and
        // whose own declared reference type carries no nullable annotation.
        //
        // Scope, and why each restriction is load-bearing:
        //
        //  * Metadata only. A symbol with any `DeclaringSyntaxReference`, or one
        //    declared in an assembly cs2gs is itself migrating, gets a G#
        //    declaration whose nullability this translator decides
        //    (`ShouldPromoteToNullableReference`); an oblivious source parameter
        //    can legitimately be emitted non-nullable, and a nullable argument to
        //    it really does need the bridge. Only a contract already frozen in
        //    metadata is read by gsc's import rule.
        //  * ORIGINAL definition's type. `List<string>.Add(T item)` substitutes
        //    to `string`, but the DECLARED parameter type is the type parameter
        //    `T`, whose `NullableAnnotation.None` says nothing about
        //    obliviousness — gsc binds the substituted `string` as non-null. Only
        //    a member whose own declared type is a concrete oblivious reference
        //    type qualifies, exactly as `IsImportedObliviousNullableMember` scopes
        //    the read side.
        private func IsImportedObliviousNullableTarget(
            targetSymbol ISymbol?,
            targetType ITypeSymbol? = nil,
            writtenValue ExpressionSyntax? = nil
        ) bool {
            if targetSymbol is IMethodSymbol method && writtenValue != nil && this.ResultLambda(
                method,
                writtenValue
            ) is {} lambda &&
                !this
                .LambdaHasExplicitDelegateCast(lambda) {
                let sink = this.ResolveValueSink(lambda)
                if sink != nil && this.TargetContractIsFrozenInMetadata(sink) {
                    let declaredDelegate ITypeSymbol? = switch sink.OriginalDefinition {
                        case parameter is IParameterSymbol: GetParamsElementType(parameter) ?? parameter.Type
                        case field is IFieldSymbol: field.Type
                        case property is IPropertySymbol: property.Type
                        case owner is IMethodSymbol: owner.ReturnType
                        default: default(ITypeSymbol?)
                    }
                    let delegateType = this.UnwrapExpressionTreeDelegateType(declaredDelegate) as INamedTypeSymbol
                    var declaredReturn = GetEffectiveReturnType(
                        delegateType?.DelegateInvokeMethod?.ReturnType,
                        lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword)
                    )
                    if this.ResolveLambdaResultTuplePath(lambda, writtenValue, nil) is {} path {
                        declaredReturn = this.GetTupleElementTypeAtPath(declaredReturn, path)
                    }
                    return ObliviousNullabilityAnalyzer.IsObliviousConcreteReferencePosition(declaredReturn)
                }
                return false
            }
            if !(
                (targetSymbol is IParameterSymbol || targetSymbol is IFieldSymbol || targetSymbol is IPropertySymbol)
            ) {
                return false
            }
            if !this.TargetContractIsFrozenInMetadata(targetSymbol) {
                return false
            }
            let original = targetSymbol!!.OriginalDefinition
            let declaredType ITypeSymbol? = switch original {
                case parameter is IParameterSymbol: if targetType != nil &&
                    targetSymbol is IParameterSymbol constructedParameter &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(targetType, GetParamsElementType(constructedParameter)) {
                    GetParamsElementType(parameter) ?? parameter.Type
                } else {
                    parameter.Type
                }
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: default(ITypeSymbol?)
            }
            return ObliviousNullabilityAnalyzer.IsObliviousConcreteReferencePosition(declaredType)
        }

        // Issue #4146 (Copilot review of #4128's fix): the assembly IDENTITIES
        // (name + version + culture + public key token — not the bare simple
        // name) this migration run emits: the current compilation's own
        // assembly plus every repository/sibling compilation's. A simple-name
        // string collision (two differently-versioned or differently-signed
        // assemblies sharing a name) would otherwise misclassify a frozen BCL
        // contract as "emitted this run" and suppress a null-bridge the
        // emitted code actually needs — a variant of #4128 itself.
        //
        // Built lazily once per document and reused by every
        // `TargetContractIsFrozenInMetadata` call instead of re-scanning
        // `RepositoryCompilations`/`SiblingCompilations` on each call, the
        // same lazy-cache-on-the-visitor shape as
        // `repositorySharedDocumentPaths` above (`IsDeclaredInRepositorySharedDocument`).
        private func EmittedAssemblyIdentities() HashSet[AssemblyIdentity]? {
            if this.emittedAssemblyIdentities == nil {
                this.emittedAssemblyIdentities = HashSet[AssemblyIdentity]{this.context.Compilation.Assembly.Identity}
                for compilation in this
                    .context
                    .RepositoryCompilations ??
                    this
                    .context
                    .SiblingCompilations ??
                    cast[IReadOnlyList[CSharpCompilation]](Array.Empty[CSharpCompilation]()) {
                    this.emittedAssemblyIdentities!!.Add(compilation.Assembly.Identity)
                }
            }
            return this.emittedAssemblyIdentities!!
        }

        // Issue #4128: whether <paramref name="targetSymbol"/>'s nullable
        // contract is already FROZEN — a declaration no project in this
        // migration run emits, so gsc reads its contract from CLR metadata and
        // nothing this translator decides (promotion of the parameter, of a
        // params element, of anything) can widen it.
        //
        // A symbol with any `DeclaringSyntaxReference` is source this run
        // translates. A syntax-less symbol whose containing assembly IDENTITY
        // matches this compilation's or any other compilation loaded in the
        // run (see `EmittedAssemblyIdentities()` above — compared structurally,
        // not by simple name, per the #4146 review) is a sibling/repository
        // project loaded as a plain metadata reference — cs2gs is emitting its
        // declaration too, so its contract is not frozen either. Everything
        // else (the BCL, NuGet packages) is.
        //
        // Extracted from `IsImportedObliviousNullableTarget` (issue #3865),
        // which asks the same same-run question before reading the frozen
        // annotation; the params-element exception in
        // `TargetWillRemainNonNullableReference` needs the question without the
        // obliviousness half.
        private func TargetContractIsFrozenInMetadata(targetSymbol ISymbol?) bool {
            let original ISymbol? = targetSymbol?.OriginalDefinition
            if original == nil || !original.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                return false
            }
            return original
                .ContainingAssembly
                ?.Identity is not{} assemblyIdentity ||
                !this.EmittedAssemblyIdentities()!!.Contains(assemblyIdentity)
        }

        // A skipped source-generated property is recreated from its hand-written
        // backing field by gsgen. Carry the property's nullable target contract
        // back to that emitted field so the recreated property has the same type.
        private func PromoteIfGeneratedPropertyTargetNullable(
            type GTypeReference?,
            field IFieldSymbol?
        ) GTypeReference? {
            if type == nil ||
                type.IsNullable ||
                field?.Type is not{IsReferenceType: true} ||
                field!!
                .Type
                .NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return type
            }
            for property in field!!.ContainingType.GetMembers().OfType[IPropertySymbol]() {
                if !this.ShouldPromoteToNullableReference(property) {
                    continue
                }
                for reference in property.DeclaringSyntaxReferences {
                    if !HasAutoGeneratedHeader(reference.SyntaxTree) ||
                        reference.GetSyntax() is not PropertyDeclarationSyntax declaration {
                        continue
                    }
                    using let modelScope = this.context.UseSemanticModelFor(reference.SyntaxTree)
                    if declaration
                        .DescendantNodes()
                        .OfType[IdentifierNameSyntax]()
                        .Any((identifier IdentifierNameSyntax) -> this.BindsTo(identifier, field)) {
                        return MakeNullable(type)
                    }
                }
            }
            return type
        }

        // The syntax region a symbol's null usage is searched in: the whole
        // enclosing method for a parameter, the whole declaring type for a field,
        // and the enclosing method body block for a local.
        private func GetNullabilityScope(symbol ISymbol?) SyntaxNode? {
            switch symbol {
                case parameter is IParameterSymbol {
                    let owner ISymbol? = switch parameter.ContainingSymbol {
                        case property is IPropertySymbol: property.PartialImplementationPart ?? property
                        default: parameter.ContainingSymbol
                    }
                    return owner?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                }
                case field is IFieldSymbol {
                    return field.ContainingType?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                }
                case property is IPropertySymbol {
                    return property.ContainingType?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                }
                case method is IMethodSymbol {
                    if method.MethodKind == MethodKind.LocalFunction {
                        return method
                            .DeclaringSyntaxReferences
                            .FirstOrDefault()
                            ?.GetSyntax()
                            .Ancestors()
                            .FirstOrDefault((a SyntaxNode) -> a is BlockSyntax)
                    }
                    return method.ContainingType?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                }
                case local is ILocalSymbol {
                    let declaration SyntaxNode? = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                    // Issue #4826: a local inside a lambda belongs to that
                    // lambda's block, not the outer method block. Crossing the
                    // lambda boundary hides its nullable consumers from scans
                    // that deliberately skip nested functions.
                    return declaration?.Ancestors().FirstOrDefault((a SyntaxNode) -> a is BlockSyntax)
                }
                default {
                    return nil
                }
            }
        }

        shared {
            // Issue #4356 follow-up: DeclaringCompilationPromotes' usage-scan
            // results, per declaring compilation (see there).
            private let DeclaringUsageScans ConditionalWeakTable[
                CSharpCompilation,
                ConcurrentDictionary[ISymbol, bool]
            ] = ConditionalWeakTable[CSharpCompilation, ConcurrentDictionary[ISymbol, bool]]()

            private func EffectiveDefaultParameter(parameter IParameterSymbol) IParameterSymbol -> switch parameter
                .ContainingSymbol {
                case method is IMethodSymbol{
                    PartialDefinitionPart: IMethodSymbol definition
                } when parameter.Ordinal >= 0 &&
                    parameter.Ordinal < definition
                    .Parameters
                    .Length: definition.Parameters[parameter.Ordinal]
                case property is IPropertySymbol{
                    PartialDefinitionPart: IPropertySymbol definition
                } when parameter.Ordinal >= 0 &&
                    parameter.Ordinal < definition
                    .Parameters
                    .Length: definition.Parameters[parameter.Ordinal]
                default: parameter
            }

            private func PartialCounterpart(symbol ISymbol?) ISymbol? -> switch symbol {
                case property is IPropertySymbol: property.PartialDefinitionPart ?? property.PartialImplementationPart
                case parameter is IParameterSymbol: switch PartialCounterpart(parameter.ContainingSymbol) {
                    case property is IPropertySymbol when parameter.Ordinal >= 0 &&
                        parameter.Ordinal < property
                        .Parameters
                        .Length: property.Parameters[parameter.Ordinal]
                    default: default(ISymbol?)
                }
                default: default(ISymbol?)
            }

            private func PartialPartnerAllowsObliviousPromotion(symbol ISymbol?) bool -> PartialCounterpart(
                symbol
            ) is not{} counterpart ||
                PromotableDeclaredType(counterpart)?.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .NotAnnotated

            // The #1072 usage scan proper: whether `scope` compares `symbol` with
            // `null`, assigns it `null`, coalesces a local, tests it `is null`, or
            // initializes it to `null`. `model` binds `scope`'s tree — this
            // compilation's own model, or (for a member another project of the run
            // declares, see DeclaringCompilationPromotes) the declaring
            // compilation's, so the consumer asks exactly what the producer asked.
            private func ScopeUsesAsNullable(model SemanticModel, symbol ISymbol?, $scope SyntaxNode?) bool {
                let counterpart ISymbol? = PartialCounterpart(symbol)
                let BindsTo = func (expression ExpressionSyntax) bool {
                    return model.GetSymbolInfo(Unparenthesize(expression)!!)
                        .Symbol is {} bound &&
                        (
                        SymbolEqualityComparer.Default.Equals(bound, symbol) ||
                            (counterpart != nil && SymbolEqualityComparer.Default.Equals(bound, counterpart))
                    )
                }
                for node in $scope!!.DescendantNodes() {
                    switch node {
                        case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.EqualsExpression) ||
                            binary
                            .IsKind(SyntaxKind.NotEqualsExpression) {
                            if (IsNullLiteral(binary.Right) && BindsTo(binary.Left)) ||
                                (IsNullLiteral(binary.Left) && BindsTo(binary.Right)) {
                                return true
                            }
                        }
                        case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                            SyntaxKind.SimpleAssignmentExpression
                        ) &&
                            BindsTo(assignment.Left) &&
                            IsNullOrSuppressedNull(assignment.Right) {
                            return true
                        }
                        case coalesceAssignment is AssignmentExpressionSyntax when coalesceAssignment.IsKind(
                            SyntaxKind.CoalesceAssignmentExpression
                        ) &&
                            BindsTo(coalesceAssignment.Left) {
                            return true
                        }
                        case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) &&
                            symbol is ILocalSymbol &&
                            BindsTo(coalesce.Left) {
                            return true
                        }
                        case isPattern is IsPatternExpressionSyntax when BindsTo(isPattern.Expression) &&
                            IsNullConstantPattern(isPattern.Pattern) {
                            return true
                        }
                        case declarator is VariableDeclaratorSyntax when declarator.Initializer != nil &&
                            IsNullOrSuppressedNull(declarator.Initializer!!.Value) &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(model.GetDeclaredSymbol(declarator), symbol) {
                            return true
                        }
                    }
                }
                return false
            }

            // Promotes <paramref name="type"/> to its nullable (`T?`) form when the
            // symbol it renders is declared as a non-nullable reference/array type yet
            // is used as nullable in its scope (issue #1072). Value types and
            // already-nullable types are left untouched: this pass only covers
            // reference-type/array null-comparison and null-assignment.
            // True for a `T?`-annotated reference type, array, or (interface/
            // unconstrained) type parameter — the forms whose `?` the G# type mapper
            // preserves and which inference over a non-null initializer would drop.
            private func IsAnnotatedNullableReference(type ITypeSymbol?) bool -> type?.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                (type!!.IsReferenceType || type is ITypeParameterSymbol)

            private func HasExplicitTypeArguments(callee ExpressionSyntax) bool -> switch callee {
                case _ is GenericNameSyntax: true
                case member is MemberAccessExpressionSyntax: HasExplicitTypeArguments(member.Name)
                case binding is MemberBindingExpressionSyntax: HasExplicitTypeArguments(binding.Name)
                default: false
            }

            private func LambdaParameterIndex(
                lambda AnonymousFunctionExpressionSyntax,
                parameter ParameterSyntax
            ) int32 {
                let list = switch lambda {
                    case paren is ParenthesizedLambdaExpressionSyntax: paren.ParameterList?.Parameters
                    case anonymous is AnonymousMethodExpressionSyntax: anonymous.ParameterList?.Parameters
                    default: nil
                }
                return list?.IndexOf(parameter) ?? 0
            }

            private func GetDelegateInvokeMethod(targetType ITypeSymbol?) IMethodSymbol? {
                var targetType = targetType
                if targetType is INamedTypeSymbol expression &&
                    expression
                    .OriginalDefinition
                    .MetadataName == "Expression`1" &&
                    expression
                    .TypeArguments
                    .Length == 1 &&
                    expression.DelegateInvokeMethod == nil &&
                    expression
                    .ContainingNamespace
                    ?.ToDisplayString() == "System.Linq.Expressions" {
                    targetType = expression.TypeArguments[0]
                }
                return (targetType as INamedTypeSymbol)?.DelegateInvokeMethod
            }

            // The <paramref name="index"/>th arrow-parameter type of a delegate-typed
            // (or `Expression<TDelegate>`-typed) callee parameter, or null when the
            // shape is not a delegate at all.
            private func DelegateParameterTypeAt(parameterType ITypeSymbol, index int32) ITypeSymbol? {
                let invoke IMethodSymbol? = GetDelegateInvokeMethod(parameterType)
                return if invoke != nil && index >= 0 && index < invoke.Parameters.Length {
                    invoke.Parameters[index].Type
                } else {
                    default(ITypeSymbol?)
                }
            }

            // True when <paramref name="type"/> mentions a METHOD type parameter
            // anywhere — i.e. one the enclosing call has to infer. A CLASS type
            // parameter is already fixed by the receiver and is not an inference
            // input here.
            private func MentionsMethodTypeParameter(type ITypeSymbol?) bool -> switch type {
                case parameter is ITypeParameterSymbol: parameter.TypeParameterKind == TypeParameterKind.Method
                case array is IArrayTypeSymbol: MentionsMethodTypeParameter(array.ElementType)
                case pointer is IPointerTypeSymbol: MentionsMethodTypeParameter(pointer.PointedAtType)
                case named is INamedTypeSymbol: named.TypeArguments.Any(MentionsMethodTypeParameter)
                default: false
            }

            private func GetMetadataTypeName(type INamedTypeSymbol) string {
                let parts = List[string]()
                for var current INamedTypeSymbol? = type; current != nil; current = current!!.ContainingType {
                    parts.Insert(0, current.MetadataName)
                }
                let nested = string.Join("+", parts)
                return if type.ContainingNamespace is {IsGlobalNamespace: false} ns {
                    ns.ToDisplayString() + "." + nested
                } else {
                    nested
                }
            }

            // Issue #914: whether <paramref name="expression"/> is a bare `null` /
            // `null!` literal or a `default` / `default(T)` expression — the direct
            // null-argument forms used to detect a null flowing into a delegate
            // parameter position.
            private func IsNullOrDefaultLiteral(expression ExpressionSyntax?) bool {
                return switch expression {
                    case literalExpressionSyntax is LiteralExpressionSyntax when literalExpressionSyntax.RawKind == int32(
                        SyntaxKind.NullLiteralExpression
                    ): true
                    case literalExpressionSyntax is LiteralExpressionSyntax when literalExpressionSyntax.RawKind == int32(
                        SyntaxKind.DefaultLiteralExpression
                    ): true
                    case _ is DefaultExpressionSyntax: true
                    case PostfixUnaryExpressionSyntax{
                        RawKind: int32(SyntaxKind.SuppressNullableWarningExpression)
                    } suppress: IsNullOrDefaultLiteral(suppress.Operand)
                    case paren is ParenthesizedExpressionSyntax: IsNullOrDefaultLiteral(paren.Expression)
                    default: false
                }
            }

            // The declared type that `ShouldPromoteToNullableReference` would render `T?`.
            private func PromotableDeclaredType(symbol ISymbol?) ITypeSymbol? -> switch symbol {
                case m is IMethodSymbol: m.ReturnType
                case f is IFieldSymbol: f.Type
                case pr is IPropertySymbol: pr.Type
                case l is ILocalSymbol: l.Type
                case p is IParameterSymbol: p.Type
                default: default(ITypeSymbol?)
            }

            /// Issue #3501: maps a positional record's synthesized property back to
            /// the primary-constructor parameter it was generated from (both
            /// symbols share the SAME (cref:ParameterSyntax) declaration).
            /// Any other symbol is returned unchanged.
            private func NormalizePositionalRecordProperty(symbol ISymbol?) ISymbol? {
                if symbol is IPropertySymbol{ContainingType: {IsRecord: true} owner} property &&
                    property
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is ParameterSyntax declaringParameter {
                    for constructor in owner.InstanceConstructors {
                        for parameter in constructor.Parameters {
                            if parameter.Name == property.Name &&
                                parameter
                                .DeclaringSyntaxReferences
                                .FirstOrDefault()
                                ?.GetSyntax() == declaringParameter {
                                return parameter
                            }
                        }
                    }
                }
                return symbol
            }

            private func IsStoredMemberNullabilitySymbol(symbol ISymbol?) bool {
                if symbol is IFieldSymbol || symbol is IPropertySymbol {
                    return true
                }
                return symbol is IParameterSymbol parameter &&
                    parameter.ContainingSymbol is IMethodSymbol method &&
                    method.MethodKind == MethodKind.Constructor &&
                    method
                    .ContainingType
                    .IsRecord
            }

            private func ParameterArgumentPreventsNullableInference(
                declaredType ITypeSymbol?,
                actualType ITypeSymbol?,
                positions ObliviousPositionSet?,
                target ITypeParameterSymbol,
                variance VarianceKind
            ) bool {
                if declaredType is ITypeParameterSymbol candidate {
                    if candidate.TypeParameterKind != target.TypeParameterKind ||
                        candidate.Ordinal != target.Ordinal ||
                        candidate.Name != target.Name {
                        return false
                    }
                    let promotedNullable = positions != nil &&
                        (positions.Nullable.Contains("") || positions.Platform.Contains(""))
                    return (variance is VarianceKind.None or VarianceKind.In) &&
                        !promotedNullable &&
                        actualType != nil &&
                        actualType.NullableAnnotation != Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated
                }
                if declaredType is IArrayTypeSymbol declaredArray {
                    return ParameterArgumentPreventsNullableInference(
                        declaredArray.ElementType,
                        (actualType as IArrayTypeSymbol)?.ElementType,
                        if positions == nil {
                            default(ObliviousPositionSet?)
                        } else {
                            Subtree(positions, "0")
                        },
                        target,
                        VarianceKind.None
                    )
                }
                if declaredType is IPointerTypeSymbol declaredPointer {
                    return ParameterArgumentPreventsNullableInference(
                        declaredPointer.PointedAtType,
                        (actualType as IPointerTypeSymbol)?.PointedAtType,
                        nil,
                        target,
                        VarianceKind.None
                    )
                }
                if declaredType is not INamedTypeSymbol declaredNamed || FlatTypeArguments(declaredNamed).Count == 0 {
                    return false
                }
                var effectiveDeclared INamedTypeSymbol = declaredNamed
                var matchingActual INamedTypeSymbol? = FindMatchingNamedTypeInHierarchy(
                    actualType,
                    declaredNamed.OriginalDefinition
                )
                if matchingActual == nil &&
                    variance == VarianceKind.In &&
                    actualType is INamedTypeSymbol actualNamed &&
                    FlatTypeArguments(actualNamed).Count > 0 &&
                    FindMatchingNamedTypeInHierarchy(
                    declaredNamed,
                    actualNamed.OriginalDefinition
                ) is {} matchedDeclared {
                    effectiveDeclared = matchedDeclared
                    matchingActual = actualNamed
                }
                let declaredArguments = FlatTypeArguments(effectiveDeclared)
                let actualArguments List[ITypeSymbol]? = if matchingActual != nil {
                    FlatTypeArguments(matchingActual)
                } else {
                    default(List[ITypeSymbol]?)
                }
                let containingOffset = if effectiveDeclared.ContainingType != nil {
                    FlatTypeArguments(effectiveDeclared.ContainingType).Count
                } else {
                    0
                }
                let view = if positions != nil && actualType != nil {
                    ViewPositions(actualType, effectiveDeclared.OriginalDefinition, positions)
                } else {
                    nil
                }
                for var flatIndex = 0; flatIndex < declaredArguments.Count; flatIndex++ {
                    let declaredArgument = declaredArguments[flatIndex]
                    let actualArgument ITypeSymbol? = if actualArguments != nil && flatIndex < actualArguments.Count {
                        actualArguments[flatIndex]
                    } else {
                        default(ITypeSymbol?)
                    }
                    let argumentPositions ObliviousPositionSet? = if view != nil && flatIndex < view.Count {
                        view[flatIndex].Positions
                    } else if positions == nil {
                        default(ObliviousPositionSet?)
                    } else {
                        Subtree(positions, IndexPosition(flatIndex))
                    }
                    let parameterVariance = if flatIndex < containingOffset {
                        VarianceKind.None
                    } else if effectiveDeclared.IsTupleType {
                        VarianceKind.Out
                    } else {
                        effectiveDeclared.TypeParameters[flatIndex - containingOffset].Variance
                    }
                    let composedVariance = if variance == VarianceKind.None || parameterVariance == VarianceKind.None {
                        VarianceKind.None
                    } else if variance == parameterVariance {
                        VarianceKind.Out
                    } else {
                        VarianceKind.In
                    }
                    if ParameterArgumentPreventsNullableInference(
                        declaredArgument,
                        actualArgument,
                        argumentPositions,
                        target,
                        composedVariance
                    ) {
                        return true
                    }
                }
                return false
            }

            private func MergeCallableSlotPositions(
                slotPattern ITypeSymbol,
                slotActual ITypeSymbol?,
                slotPositions ObliviousPositionSet?,
                slotVariance VarianceKind,
                bindings Dictionary[ITypeParameterSymbol, ObliviousPositionSet],
                boundParameters HashSet[ITypeParameterSymbol]
            ) {
                let mentioned = HashSet[ITypeParameterSymbol](SymbolEqualityComparer.Default)
                CollectMentionedTypeParameters(slotPattern, mentioned)
                if mentioned.Count == 0 {
                    return
                }
                let slotBindings = TypeParameterMap()
                if slotPositions != nil {
                    Unify(slotPattern, slotActual, slotPositions, slotBindings)
                }
                for typeParameter in mentioned {
                    let incoming = if slotBindings.TryGetValue(typeParameter, out var found) {
                        found
                    } else {
                        ObliviousPositionSet()
                    }
                    let covariantTopLevel = slotVariance == VarianceKind.Out && SymbolEqualityComparer.Default.Equals(
                        slotPattern,
                        typeParameter
                    ) &&
                        slotActual?.IsReferenceType == true
                    if boundParameters.Add(typeParameter) {
                        let copy = ObliviousPositionSet()
                        copy.UnionWith(incoming)
                        bindings[typeParameter] = copy
                    } else if bindings.TryGetValue(typeParameter, out var existing) {
                        let keepTopNullable = covariantTopLevel && existing.Nullable.Contains("")
                        let keepTopPlatform = covariantTopLevel && existing.Platform.Contains("")
                        existing.Nullable.IntersectWith(incoming.Nullable)
                        existing.Platform.IntersectWith(incoming.Platform)
                        if keepTopNullable {
                            existing.Nullable.Add("")
                        }
                        if keepTopPlatform {
                            existing.Platform.Add("")
                        }
                    }
                }
            }

            private func CollectMentionedTypeParameters(type ITypeSymbol?, result HashSet[ITypeParameterSymbol]) {
                if type == nil {
                    return
                }
                if type is ITypeParameterSymbol typeParameter {
                    result.Add(typeParameter)
                    return
                }
                let arguments = PositionArguments(type)
                if arguments == nil {
                    return
                }
                for argument in arguments {
                    CollectMentionedTypeParameters(argument, result)
                }
            }

            private func BindCallableTypeParameters(
                patternType ITypeSymbol?,
                actualType ITypeSymbol?,
                variance VarianceKind,
                bindings Dictionary[ITypeParameterSymbol, ITypeSymbol],
                compilation Compilation
            ) {
                if patternType == nil || actualType == nil {
                    return
                }
                if patternType is ITypeParameterSymbol typeParameter {
                    let boundActual = ToCallableBoundType(actualType, variance, compilation)
                    if bindings.TryGetValue(typeParameter, out var existing) {
                        bindings[typeParameter] = ReconcileCallableBoundType(existing, boundActual, compilation)
                    } else {
                        bindings[typeParameter] = boundActual
                    }
                    return
                }
                if patternType is IArrayTypeSymbol patternArray && actualType is IArrayTypeSymbol actualArray {
                    BindCallableTypeParameters(
                        patternArray.ElementType,
                        actualArray.ElementType,
                        VarianceKind.None,
                        bindings,
                        compilation
                    )
                    return
                }
                if patternType is INamedTypeSymbol patternNamed && FlatTypeArguments(patternNamed).Count > 0 {
                    var effectivePattern INamedTypeSymbol = patternNamed
                    var matchingActual INamedTypeSymbol? = FindMatchingNamedTypeInHierarchy(
                        actualType,
                        patternNamed.OriginalDefinition
                    )
                    if matchingActual == nil && actualType is INamedTypeSymbol actualNamed && FlatTypeArguments(
                        actualNamed
                    ).Count > 0 &&
                        FindMatchingNamedTypeInHierarchy(
                        patternNamed,
                        actualNamed.OriginalDefinition
                    ) is {} matchedPattern {
                        effectivePattern = matchedPattern
                        matchingActual = actualNamed
                    }
                    if matchingActual != nil {
                        let patternArgs = FlatTypeArguments(effectivePattern)
                        let actualArgs = FlatTypeArguments(matchingActual)
                        let containingOffset = if effectivePattern.ContainingType != nil {
                            FlatTypeArguments(effectivePattern.ContainingType).Count
                        } else {
                            0
                        }
                        for var i = 0; i < patternArgs.Count && i < actualArgs.Count; i++ {
                            let parameterVariance = if i < containingOffset {
                                VarianceKind.None
                            } else if effectivePattern.IsTupleType {
                                VarianceKind.Out
                            } else {
                                effectivePattern.TypeParameters[i - containingOffset].Variance
                            }
                            let composedVariance = if variance == VarianceKind.None ||
                                parameterVariance == VarianceKind.None {
                                VarianceKind.None
                            } else if variance == parameterVariance {
                                VarianceKind.Out
                            } else {
                                VarianceKind.In
                            }
                            BindCallableTypeParameters(
                                patternArgs[i],
                                actualArgs[i],
                                composedVariance,
                                bindings,
                                compilation
                            )
                        }
                    }
                }
            }

            private func ToCallableBoundType(
                actualType ITypeSymbol,
                variance VarianceKind,
                compilation Compilation
            ) ITypeSymbol {
                var result = actualType
                if result is IArrayTypeSymbol arrayType {
                    let element = ToCallableBoundType(arrayType.ElementType, VarianceKind.None, compilation)
                    result = compilation.CreateArrayTypeSymbol(element, arrayType.Rank).WithNullableAnnotation(
                        arrayType.NullableAnnotation
                    )
                } else if result is INamedTypeSymbol{IsGenericType: true} namedType &&
                    namedType
                    .TypeArguments
                    .Length == namedType
                    .TypeParameters
                    .Length {
                    let rebuiltContaining = if namedType.ContainingType != nil {
                        ToCallableBoundType(
                            namedType.ContainingType,
                            VarianceKind.None,
                            compilation
                        ) as INamedTypeSymbol
                    } else {
                        default(INamedTypeSymbol?)
                    }
                    let typeArguments = List[ITypeSymbol](namedType.TypeArguments.Length)
                    for var i = 0; i < namedType.TypeArguments.Length; i++ {
                        let parameterVariance = if namedType.IsTupleType {
                            VarianceKind.Out
                        } else {
                            namedType.TypeParameters[i].Variance
                        }
                        let composedVariance = if variance == VarianceKind.None ||
                            parameterVariance == VarianceKind.None {
                            VarianceKind.None
                        } else if variance == parameterVariance {
                            VarianceKind.Out
                        } else {
                            VarianceKind.In
                        }
                        typeArguments.Add(
                            ToCallableBoundType(namedType.TypeArguments[i], composedVariance, compilation)
                        )
                    }
                    result = ConstructNamedTypeWithContaining(
                        namedType,
                        rebuiltContaining,
                        typeArguments,
                        namedType.NullableAnnotation
                    )
                }
                return if variance == VarianceKind.Out && result.IsReferenceType {
                    result.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
                } else {
                    result
                }
            }

            private func ReconcileCallableBoundType(
                existing ITypeSymbol,
                candidate ITypeSymbol,
                compilation Compilation
            ) ITypeSymbol {
                let reconciledAnnotation = if existing.NullableAnnotation != Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    existing.NullableAnnotation
                } else {
                    candidate.NullableAnnotation
                }
                if existing is IArrayTypeSymbol existingArray &&
                    candidate is IArrayTypeSymbol candidateArray &&
                    existingArray.Rank == candidateArray
                    .Rank {
                    let reconciledElement = ReconcileCallableBoundType(
                        existingArray.ElementType,
                        candidateArray.ElementType,
                        compilation
                    )
                    return compilation.CreateArrayTypeSymbol(reconciledElement, existingArray.Rank)
                        .WithNullableAnnotation(reconciledAnnotation)
                }
                if existing is INamedTypeSymbol{IsGenericType: true} existingNamed &&
                    candidate is INamedTypeSymbol{IsGenericType: true} candidateNamed &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(existingNamed.OriginalDefinition, candidateNamed.OriginalDefinition) &&
                    existingNamed
                    .TypeArguments
                    .Length == candidateNamed
                    .TypeArguments
                    .Length {
                    let rebuiltContaining = if existingNamed.ContainingType != nil &&
                        candidateNamed.ContainingType != nil {
                        ReconcileCallableBoundType(
                            existingNamed.ContainingType,
                            candidateNamed.ContainingType,
                            compilation
                        ) as INamedTypeSymbol
                    } else {
                        existingNamed.ContainingType
                    }
                    let typeArguments = List[ITypeSymbol](existingNamed.TypeArguments.Length)
                    for var i = 0; i < existingNamed.TypeArguments.Length; i++ {
                        typeArguments.Add(
                            ReconcileCallableBoundType(
                                existingNamed.TypeArguments[i],
                                candidateNamed.TypeArguments[i],
                                compilation
                            )
                        )
                    }
                    return ConstructNamedTypeWithContaining(
                        existingNamed,
                        rebuiltContaining,
                        typeArguments,
                        reconciledAnnotation
                    )
                }
                return existing.WithNullableAnnotation(reconciledAnnotation)
            }

            private func ConstructNamedTypeWithContaining(
                template INamedTypeSymbol,
                rebuiltContaining INamedTypeSymbol?,
                typeArguments List[ITypeSymbol],
                annotation Microsoft.CodeAnalysis.NullableAnnotation
            ) ITypeSymbol {
                var definition INamedTypeSymbol = template.ConstructedFrom
                if rebuiltContaining != nil && !SymbolEqualityComparer.IncludeNullability.Equals(
                    rebuiltContaining,
                    template.ContainingType
                ) &&
                    rebuiltContaining
                    .GetTypeMembers(template.Name, template.Arity).FirstOrDefault() is {} nestedDefinition {
                    definition = nestedDefinition
                }
                let constructed INamedTypeSymbol = if typeArguments.Count > 0 {
                    definition.Construct(typeArguments.ToArray())
                } else {
                    definition
                }
                return constructed.WithNullableAnnotation(annotation)
            }

            private func FindMatchingNamedTypeInHierarchy(
                actualType ITypeSymbol?,
                targetDefinition INamedTypeSymbol,
                visitedTypeParameters HashSet[ITypeParameterSymbol]? = nil
            ) INamedTypeSymbol? {
                switch actualType {
                    case actualNamed is INamedTypeSymbol {
                        return ReceiverTypeHierarchy(actualNamed).FirstOrDefault(
                            (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                                candidate.OriginalDefinition,
                                targetDefinition
                            )
                        )
                    }
                    case actualArray is IArrayTypeSymbol {
                        return actualArray.AllInterfaces.FirstOrDefault(
                            (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                                candidate.OriginalDefinition,
                                targetDefinition
                            )
                        )
                    }
                    case actualTypeParameter is ITypeParameterSymbol {
                        let visited = visitedTypeParameters ??
                            HashSet[ITypeParameterSymbol](SymbolEqualityComparer.Default)
                        if !visited.Add(actualTypeParameter) {
                            return nil
                        }
                        for constraintType in actualTypeParameter.ConstraintTypes {
                            if FindMatchingNamedTypeInHierarchy(
                                constraintType,
                                targetDefinition,
                                visited
                            ) is {} matched {
                                return matched
                            }
                        }
                        return nil
                    }
                    default {
                        return nil
                    }
                }
            }

            private func MentionsTypeParameterOnlyInvariantly(
                type ITypeSymbol,
                typeParameter ITypeParameterSymbol
            ) bool {
                switch type {
                    case INamedTypeSymbol{IsGenericType: true} named {
                        // A nested type also carries its containing types' type
                        // parameters, which no variance annotation covers.
                        if MentionsTypeParameter(named.ContainingType, typeParameter) {
                            return false
                        }
                        for var i = 0; i < named.TypeArguments.Length; i++ {
                            let argument = named.TypeArguments[i]
                            if !MentionsTypeParameter(argument, typeParameter) {
                                continue
                            }
                            if named
                                .TypeParameters[i]
                                .Variance != VarianceKind.None ||
                                (
                                !(argument is ITypeParameterSymbol) &&
                                    !MentionsTypeParameterOnlyInvariantly(argument, typeParameter)
                            ) {
                                return false
                            }
                        }
                        return true
                    }
                    default {
                        return !MentionsTypeParameter(type, typeParameter)
                    }
                }
            }

            // Issue #3886: whether <paramref name="symbol"/> is a parameter that
            // `TranslateParameter` emits as an ADR-0173 variadic carrier (`...T` /
            // `...List[T]`). Kept in lockstep with the `variadic` local there: only
            // a genuine `params T[]` or a SUPPORTED params collection becomes a
            // carrier — an unsupported shape (e.g. `params HashSet<T>`) gaps and
            // keeps ordinary-parameter promotion.
            private func IsVariadicCarrierParameter(symbol ISymbol?) bool -> symbol is IParameterSymbol{
                IsParams: true
            } parameter &&
                (parameter.Type is IArrayTypeSymbol || IsSupportedParamsCollectionType(parameter.Type))

            private func HasAutoGeneratedHeader(
                tree SyntaxTree?
            ) bool -> ObliviousNullabilityAnalyzer.HasAutoGeneratedHeader(tree)

            // `x is null` / `x is not null` constant pattern (the C# pattern form of a
            // null comparison, which the translator lowers to `== nil` / `!= nil`).
            private func IsNullConstantPattern(pattern PatternSyntax) bool {
                var pattern = pattern
                if pattern is UnaryPatternSyntax unary && unary.IsKind(SyntaxKind.NotPattern) {
                    pattern = unary.Pattern
                }
                return pattern is ConstantPatternSyntax constant && IsNullLiteral(constant.Expression)
            }

            private func IsNullLiteral(
                expression ExpressionSyntax?
            ) bool -> expression is LiteralExpressionSyntax literal &&
                literal.IsKind(SyntaxKind.NullLiteralExpression)

            // `null`, parenthesized null, or either form under C# null suppression.
            private func IsNullOrSuppressedNull(expression ExpressionSyntax?) bool -> switch expression {
                case parenthesized is ParenthesizedExpressionSyntax: IsNullOrSuppressedNull(parenthesized.Expression)
                case suppress is PostfixUnaryExpressionSyntax when suppress.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ): IsNullOrSuppressedNull(suppress.Operand)
                default: IsNullLiteral(expression)
            }
        }
    }
}
