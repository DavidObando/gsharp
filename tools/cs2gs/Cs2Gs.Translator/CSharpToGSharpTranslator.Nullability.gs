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

        private var repositoryCompilationsByIdentity Dictionary[AssemblyIdentity, CSharpCompilation]?
        private var repositorySharedDocumentPaths HashSet[string]?

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
            ) {
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
                    return this.context.GetSymbolInfo(assignment.Left).Symbol
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
            if symbol is ILocalSymbol local && !this.ShouldPromoteToNullableReference(local) &&
                local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} localInitializer}} {
                return this.IsNullablePromotedValue(localInitializer)
            }
            return switch symbol {
                case _ is IFieldSymbol or
                    _ is IPropertySymbol or
                    _ is ILocalSymbol or
                    _ is IParameterSymbol or
                    _ is IMethodSymbol: this.ShouldPromoteToNullableReference(symbol)
                default: false
            }
        }

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
            elementType GTypeReference?,
            elementTypeSymbol ITypeSymbol?,
            elements IEnumerable[ExpressionSyntax],
            literal ExpressionSyntax? = nil
        ) GTypeReference? {
            if elementType == nil ||
                elementType.IsNullable ||
                !(elementTypeSymbol != nil && elementTypeSymbol.IsReferenceType == true) ||
                elementTypeSymbol.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return elementType
            }
            if literal != nil && this.IsGeneratedArrayElementPromotedSink(this.ResolveValueSink(literal)) {
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
            if !(type is ArrayTypeReference{ElementType: {IsNullable: false} element} array) ||
                !this.IsGeneratedArrayElementPromotedSink(symbol) {
                return type
            }
            return ArrayTypeReference(MakeNullable(element), array.Rank){IsNullable = array.IsNullable}
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
                case ternary is ConditionalExpressionSyntax {
                    return this.IsNullableInitializer(ternary.WhenTrue) || this.IsNullableInitializer(ternary.WhenFalse)
                }
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
        /// that an `out var` / `out T x` argument declares for such a parameter (G# infers the local's
        /// type from the widened parameter).
        /// @remarks This is the one place that names the declarations whose reads need a forgiving
        /// `!!` when the C# flow state at the read is non-null (issue #5254). The flow-state rule
        /// itself stays in `ReceiverNeedsNullForgiveness`.
        private func IsTranslatorWidenedDeclaration(symbol ISymbol?) bool {
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
            return false
        }

        private func ShouldPromoteToNullableReference(symbol ISymbol?) bool {
            let declared ITypeSymbol? = switch symbol {
                case m is IMethodSymbol: m.ReturnType
                case f is IFieldSymbol: f.Type
                case pr is IPropertySymbol: pr.Type
                case l is ILocalSymbol: l.Type
                case p is IParameterSymbol: p.Type
                default: default(ITypeSymbol?)
            }
            if !(declared != nil && declared.IsReferenceType == true) ||
                declared.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
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
            if symbol is IParameterSymbol{HasExplicitDefaultValue: true} defaulted &&
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
            if declared.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .None &&
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

        // Issue #3501: file paths that appear in MORE THAN ONE repository
        // compilation — linked/shared sources whose translation must not
        // depend on which project is being translated.
        private func IsDeclaredInRepositorySharedDocument(symbol ISymbol?) bool {
            if this.context.RepositoryCompilations is not{Count: > 1} repository {
                return false
            }
            if this.repositorySharedDocumentPaths == nil {
                let counts = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase)
                for compilation in repository {
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
            for reference in symbol!!.DeclaringSyntaxReferences {
                let path string? = reference.SyntaxTree?.FilePath
                if !string.IsNullOrEmpty(path) && this.repositorySharedDocumentPaths!!.Contains(path!!) {
                    return true
                }
            }
            return false
        }

        // Issue #2521: sink lowering must use the target contract that G# will
        // actually bind, not consumer-side taint recorded for an imported
        // symbol. Only declarations emitted by this compilation can have their
        // contract widened by this compilation's promotion result. Project
        // references and CLR metadata retain their already-emitted contract.
        private func TargetWillRemainNonNullableReference(targetType ITypeSymbol?, targetSymbol ISymbol?) bool {
            if !(targetType != nil && targetType.IsReferenceType == true) ||
                targetType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
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
            if ObliviousNullabilityAnalyzer.HasAllowNullWriteContract(targetSymbol) {
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
            if this.IsImportedObliviousNullableTarget(targetSymbol) {
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
                return !(targetSymbol is IParameterSymbol{Type: IArrayTypeSymbol array} paramsParameter) ||
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
            ) == true
            return !(targetDeclaredInThisCompilation && this.IsTranslatorWidenedDeclaration(targetSymbol))
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
            if !(parameter.OriginalDefinition is {Type: ITypeParameterSymbol typeParameter} original) ||
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
                !IsInferredGenericParameterTarget(parameter, argumentExpression) ||
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
        private func IsImportedObliviousNullableTarget(targetSymbol ISymbol?) bool {
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
                case parameter is IParameterSymbol: parameter.Type
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
                    return parameter.ContainingSymbol?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                }
                case field is IFieldSymbol {
                    return field.ContainingType?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                }
                case property is IPropertySymbol {
                    return property.ContainingType?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
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

            // The #1072 usage scan proper: whether `scope` compares `symbol` with
            // `null`, assigns it `null`, coalesces a local, tests it `is null`, or
            // initializes it to `null`. `model` binds `scope`'s tree — this
            // compilation's own model, or (for a member another project of the run
            // declares, see DeclaringCompilationPromotes) the declaring
            // compilation's, so the consumer asks exactly what the producer asked.
            private func ScopeUsesAsNullable(model SemanticModel, symbol ISymbol?, $scope SyntaxNode?) bool {
                let BindsTo = func (expression ExpressionSyntax) bool {
                    return model.GetSymbolInfo(Unparenthesize(expression)!!)
                        .Symbol is {} bound &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(bound, symbol)
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
