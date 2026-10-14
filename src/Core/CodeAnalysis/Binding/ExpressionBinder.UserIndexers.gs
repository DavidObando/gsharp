// <copyright file="ExpressionBinder.UserIndexers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering.Async
import System.Reflection

/// ADR-0187 / issue #4350: overload resolution for user-declared indexers.
/// A G# struct, class, or interface may declare several `prop this[...]`
/// indexers that differ by index-parameter signature, exactly like C#.
internal partial class ExpressionBinder {
    /// Returns every indexer visible on [`receiverType`](paramref):
    /// the indexers of the receiver's own definition and of its bases, with a
    /// base indexer hidden by a more-derived indexer of the same (substituted)
    /// signature (C# hide-by-signature). The returned properties are the OPEN
    /// definition members so their accessors resolve to emitted MethodDefs;
    /// each carries the substitution from its declaring level's type
    /// parameters to the receiver's type arguments (review finding: a
    /// constructed base such as `IBase[int32]` must keep its arguments).
    /// @param receiverType The indexed receiver's static type.
    /// @returns The visible indexers, most-derived first.
    private func GetVisibleUserIndexers(receiverType TypeSymbol) ImmutableArray[VisibleUserIndexer] {
        let builder = ImmutableArray.CreateBuilder[VisibleUserIndexer]()
        let receiverSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]? = LevelSubstitution(
            receiverType,
            outer: nil
        )
        let AddLevel = func (level TypeSymbol, properties ImmutableArray[PropertySymbol], isReceiverLevel bool) {
            let substitution = if isReceiverLevel {
                receiverSubstitution
            } else {
                MergeSubstitutions(receiverSubstitution, LevelSubstitution(level, receiverSubstitution))
            }
            // A constructed BASE level is reached through a receiver upcast to
            // that level (`IBase[int32]` under `IDerived`), so the accessor is
            // parented at the base's own constructed TypeSpec.
            var view TypeSymbol? = nil
            if !isReceiverLevel && LevelSubstitution(level, outer: nil) != nil {
                view = if receiverSubstitution != nil {
                    SubstituteIndexerType(level, receiverSubstitution)
                } else {
                    level
                }
            }
            for property in properties {
                // Review finding (#4350): an explicit-interface indexer
                // (`prop (IRepo) this[...]`) is reachable only through its
                // interface, never by indexing the implementing type.
                if !property.IsIndexer || property.HasExplicitInterfaceClause {
                    continue
                }
                var hidden = false
                for existing in builder {
                    if SameSubstitutedIndexerSignature(existing, property, substitution) {
                        hidden = true
                        break
                    }
                }
                if !hidden {
                    builder.Add(VisibleUserIndexer(property, substitution, view))
                }
            }
        }
        switch receiverType {
            case structType is StructSymbol {
                let structDefinition = structType.Definition ?? structType
                for level in structDefinition.GetHierarchy() {
                    AddLevel(
                        level,
                        (level.Definition ?? level).Properties,
                        object.ReferenceEquals(level, structDefinition)
                    )
                }
            }
            case interfaceType is InterfaceSymbol {
                for level in interfaceType.SelfAndAllBaseInterfaces() {
                    AddLevel(
                        level,
                        (level.Definition ?? level).Properties,
                        object.ReferenceEquals(level, interfaceType)
                    )
                }
            }
        }
        return builder.ToImmutable()
    }

    // The substitution from a constructed level's definition type parameters to
    // its type arguments, each argument re-substituted through the receiver's
    // own map (`IDerived[U] : IBase[U]` indexed as `IDerived[int32]`).
    private func LevelSubstitution(level TypeSymbol, outer Dictionary[TypeParameterSymbol, TypeSymbol]?) Dictionary[
        TypeParameterSymbol,
        TypeSymbol
    ]? {
        let (definitionParameters, typeArguments) = switch level {
            case StructSymbol{Definition: {} definition} constructed when !object.ReferenceEquals(
                definition,
                constructed
            ): (definition.TypeParameters, constructed.TypeArguments)
            case InterfaceSymbol{Definition: {} definition} constructed when !object.ReferenceEquals(
                definition,
                constructed
            ): (definition.TypeParameters, constructed.TypeArguments)
            default: (ImmutableArray[TypeParameterSymbol].Empty, ImmutableArray[TypeSymbol].Empty)
        }
        if definitionParameters.IsDefaultOrEmpty ||
            typeArguments.IsDefaultOrEmpty ||
            definitionParameters.Length != typeArguments.Length {
            return nil
        }
        let map_ = Dictionary[TypeParameterSymbol, TypeSymbol](definitionParameters.Length)
        for var i = 0; i < definitionParameters.Length; i++ {
            map_[definitionParameters[i]] = if outer != nil {
                SubstituteIndexerType(typeArguments[i], outer)
            } else {
                typeArguments[i]
            }
        }
        return map_
    }

    private func SameSubstitutedIndexerSignature(
        existing VisibleUserIndexer,
        candidate PropertySymbol,
        candidateSubstitution Dictionary[TypeParameterSymbol, TypeSymbol]?
    ) bool {
        if existing.Indexer.Parameters.Length != candidate.Parameters.Length {
            return false
        }
        for var i = 0; i < candidate.Parameters.Length; i++ {
            if existing
                .Indexer
                .Parameters[i]
                .RefKind != candidate
                .Parameters[i]
                .RefKind ||
                !DeclarationBinder
                .TypeSignaturesEquivalent(
                SubstituteIndexerType(existing.Indexer.Parameters[i].Type, existing.Substitution),
                SubstituteIndexerType(candidate.Parameters[i].Type, candidateSubstitution)
            ) {
                return false
            }
        }
        return true
    }

    /// Selects the user indexer an index access with
    /// [`argumentCount`](paramref) arguments binds to.
    /// @param receiverType The indexed receiver's static type.
    /// @param argumentCount The number of index arguments written.
    /// @param bindArguments Binds the index arguments; called only when
    /// more than one indexer of the right arity remains, so a single-candidate
    /// access keeps target-typed argument binding.
    /// @param location The location used for resolution diagnostics.
    /// @param indexer The selected OPEN indexer.
    /// @param substitution The receiver's type-parameter substitution, if any.
    /// @param boundArguments The pre-bound arguments, or default when not bound.
    /// @param reported Whether a resolution diagnostic was reported.
    /// @param view The constructed base type to view the receiver as, when the indexer is inherited from
    /// one.
    /// @returns `true` when an indexer was selected.
    private func TryResolveUserIndexer(
        receiverType TypeSymbol,
        argumentCount int32,
        bindArguments() -> ImmutableArray[BoundExpression],
        location TextLocation,
        @NotNullWhen(true) out indexer PropertySymbol?,
        out substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
        out boundArguments ImmutableArray[BoundExpression],
        out reported bool,
        out view TypeSymbol?
    ) bool {
        indexer = nil
        substitution = nil
        view = nil
        boundArguments = default(ImmutableArray[BoundExpression])
        reported = false
        let visible = GetVisibleUserIndexers(receiverType)
        if visible.IsEmpty {
            return false
        }
        let arityMatches = ImmutableArray.CreateBuilder[VisibleUserIndexer]()
        for candidate in visible {
            if AcceptsIndexArgumentCount(candidate.Indexer, argumentCount) {
                arityMatches.Add(candidate)
            }
        }
        if arityMatches.Count == 0 {
            if visible.Length > 1 {
                let _ = bindArguments()
                Diagnostics.ReportNoApplicableOverload(location, "this[]")
                reported = true
            }
            return false
        }
        if arityMatches.Count == 1 {
            indexer = arityMatches[0].Indexer
            substitution = arityMatches[0].Substitution
            view = arityMatches[0].View
            return true
        }
        boundArguments = bindArguments()
        for argument in boundArguments {
            if argument is BoundErrorExpression || argument.Type == TypeSymbol.Error {
                reported = true
                return false
            }
        }
        // Rank the candidates through the ordinary user-overload resolver by
        // presenting each indexer as a synthetic function over its (receiver-
        // substituted) index parameters.
        let synthetic = ImmutableArray.CreateBuilder[FunctionSymbol](arityMatches.Count)
        let byFunction = Dictionary[FunctionSymbol, VisibleUserIndexer](arityMatches.Count)
        for visibleCandidate in arityMatches {
            let candidate = visibleCandidate.Indexer
            let candidateSubstitution = visibleCandidate.Substitution
            let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](candidate.Parameters.Length)
            for parameter in candidate.Parameters {
                let syntheticParameter = ParameterSymbol(
                    parameter,
                    SubstituteIndexerType(parameter.Type, candidateSubstitution)
                )
                if parameter.HasExplicitDefaultValue {
                    syntheticParameter.SetExplicitDefaultValue(parameter.ExplicitDefaultValue)
                }
                parameters.Add(syntheticParameter)
            }
            let function = FunctionSymbol(
                "this[]",
                parameters.MoveToImmutable(),
                SubstituteIndexerType(candidate.Type, candidateSubstitution)
            )
            synthetic.Add(function)
            byFunction[function] = visibleCandidate
        }
        let selected FunctionSymbol? = overloads.SelectBestInstanceOverload(
            synthetic.MoveToImmutable(),
            argumentCount,
            argumentNames: default(ImmutableArray[string]),
            boundArguments,
            out var ambiguous,
            out _
        )
        if selected == nil {
            if ambiguous {
                Diagnostics.ReportAmbiguousOverloadResolution(location, "this[]")
            } else {
                Diagnostics.ReportNoApplicableOverload(location, "this[]")
            }
            reported = true
            return false
        }
        indexer = byFunction[selected].Indexer
        substitution = byFunction[selected].Substitution
        view = byFunction[selected].View
        return true
    }

    /// Selects a user indexer that takes exactly one index parameter of the
    /// given CLR type (for the `System.Index` / `System.Range` value
    /// paths, which C# binds to such an indexer when one is declared).
    /// @param receiverType The indexed receiver's static type.
    /// @param parameterClrType The required index-parameter CLR type.
    /// @param indexer The matching OPEN indexer.
    /// @param substitution The receiver's type-parameter substitution, if any.
    /// @param view The constructed base type to view the receiver as, when the indexer is inherited from
    /// one.
    /// @returns `true` when such an indexer is declared.
    private func TryGetUserIndexerTaking(
        receiverType TypeSymbol,
        parameterClrType Type,
        @NotNullWhen(true) out indexer PropertySymbol?,
        out substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
        out view TypeSymbol?
    ) bool {
        indexer = nil
        substitution = nil
        view = nil
        for candidate in GetVisibleUserIndexers(receiverType) {
            if candidate.Indexer.Parameters.Length == 1 && ClrTypeUtilities.AreSame(
                SubstituteIndexerType(candidate.Indexer.Parameters[0].Type, candidate.Substitution).ClrType,
                parameterClrType
            ) {
                indexer = candidate.Indexer
                substitution = candidate.Substitution
                view = candidate.View
                return true
            }
        }
        return false
    }

    /// Binds a read of a selected user indexer: converts each index argument
    /// to its (substituted) parameter type and calls the getter.
    /// @param target The indexed receiver.
    /// @param indexer The selected OPEN indexer.
    /// @param substitution The receiver's type-parameter substitution.
    /// @param convert Converts argument `i` to the given parameter type.
    /// @param targetLocation The receiver location for diagnostics.
    /// @param writtenArgumentCount How many index arguments were written;
    /// trailing optional parameters beyond them take their declared defaults.
    /// @returns The bound getter call, or an error when the indexer has no getter.
    private func BindUserIndexerRead(
        target BoundExpression,
        indexer PropertySymbol,
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
        convert(int32, TypeSymbol) -> BoundExpression,
        targetLocation TextLocation,
        writtenArgumentCount int32? = nil
    ) BoundExpression {
        let argumentCount = writtenArgumentCount ?? indexer.Parameters.Length
        if indexer.GetterSymbol == nil {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type)
            return BoundErrorExpression(nil)
        }
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](indexer.Parameters.Length)
        for var i = 0; i < indexer.Parameters.Length; i++ {
            let parameterType = SubstituteIndexerType(indexer.Parameters[i].Type, substitution)
            arguments.Add(
                if i < argumentCount {
                    convert(i, parameterType)
                } else {
                    IndexerDefaultArgument(indexer.Parameters[i], parameterType)
                }
            )
        }
        if !CheckUserIndexerAccessibility(indexer, requireGetter: true, requireSetter: false, targetLocation) {
            return BoundErrorExpression(nil)
        }
        return BoundUserInstanceCallExpression(
            nil,
            target,
            indexer.GetterSymbol!!,
            arguments.MoveToImmutable(),
            SubstituteIndexerType(indexer.Type, substitution)
        )
    }

    /// Binds `target[a, b, …] = value` (or a compound form) against a
    /// multi-parameter user indexer: the arguments are evaluated once, left to
    /// right, and the value is stored through the selected setter, or through
    /// a writable ref-returning getter when the indexer has no setter.
    /// @param target The indexed receiver.
    /// @param indexSyntaxes The written index arguments.
    /// @param bindValue Binds the stored value given the element type
    /// and a read of the current element (for compound assignment).
    /// @param bindValueForRecovery Binds the stored-value syntax without
    /// requiring an indexer read when accessibility recovery stops the write.
    /// @param location The location for diagnostics.
    /// @param requiresRead Whether the assignment also invokes the getter.
    /// @param returnsPreviousValue Whether the result is the element's previous value (postfix
    /// increment/decrement).
    /// @returns The bound assignment, or `null` when the target
    /// declares no user indexer (the caller keeps its rectangular-array path).
    private func TryBindMultiIndexUserAssignment(
        target BoundExpression,
        indexSyntaxes GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        bindValue(TypeSymbol, () -> BoundExpression) -> BoundExpression,
        bindValueForRecovery(TypeSymbol) -> void,
        location TextLocation,
        requiresRead bool,
        returnsPreviousValue bool = false
    ) BoundExpression? {
        var target = target
        if (target.Type is ImportedTypeSymbol or NullabilityAnnotatedTypeSymbol) &&
            target
            .Type
            .ClrType is {} clrTarget {
            return TryBindMultiIndexClrAssignment(
                target,
                clrTarget,
                indexSyntaxes,
                bindValue,
                location,
                returnsPreviousValue
            )
        }
        if target.Type is not(StructSymbol or InterfaceSymbol) {
            return nil
        }
        let BindAll = func () ImmutableArray[BoundExpression] {
            let bound = ImmutableArray.CreateBuilder[BoundExpression](indexSyntaxes.Count)
            for indexSyntax in indexSyntaxes {
                bound.Add(BindExpression(indexSyntax))
            }
            return bound.MoveToImmutable()
        }
        if !TryResolveUserIndexer(
            target.Type,
            indexSyntaxes.Count,
            BindAll,
            location,
            out var selected,
            out var substitution,
            out var preBound,
            out var reported,
            out var view
        ) {
            return if reported {
                BoundErrorExpression(nil)
            } else {
                default(BoundErrorExpression?)
            }
        }
        target = ViewIndexerReceiver(target, view, location)
        let indexer = selected
        if RefCapabilities.IsReadOnlyValueReference(target) {
            Diagnostics.ReportCannotAssign(location, "this[]")
            return BoundErrorExpression(nil)
        }
        let setter FunctionSymbol? = indexer!!.SetterSymbol
        let refGetter = if setter == nil &&
            target.Type is StructSymbol &&
            indexer!!.GetterSymbol is {ReturnRefKind: RefKind.Ref} getter {
            getter
        } else {
            default(FunctionSymbol?)
        }
        let storedType TypeSymbol? = refGetter?.Type ?? setter?.Parameters[^1].Type
        if storedType == nil {
            Diagnostics.ReportTypeNotIndexable(location, target.Type)
            return BoundErrorExpression(nil)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        var receiver = target
        if !(target is BoundVariableExpression) {
            let receiverLocal = DeclareRangeTemp("receiver", target.Type, target, statements)
            receiver = BoundVariableExpression(nil, receiverLocal)
        }
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](indexer!!.Parameters.Length)
        for var i = 0; i < indexer!!.Parameters.Length; i++ {
            let parameterType = SubstituteIndexerType(indexer!!.Parameters[i].Type, substitution)
            let converted = if i >= indexSyntaxes.Count {
                IndexerDefaultArgument(indexer!!.Parameters[i], parameterType)
            } else {
                (
                    if preBound.IsDefault {
                        conversions.BindConversion(indexSyntaxes[i], parameterType)
                    } else {
                        conversions.BindConversion(indexSyntaxes[i].Location, preBound[i], parameterType)
                    }
                )
            }
            let argumentLocal = DeclareRangeTemp("index", parameterType, converted, statements)
            arguments.Add(BoundVariableExpression(nil, argumentLocal))
        }
        let capturedArguments = arguments.MoveToImmutable()
        let elementType = SubstituteIndexerType(storedType, substitution)
        if requiresRead && indexer!!.GetterSymbol == nil {
            bindValueForRecovery(elementType)
            Diagnostics.ReportTypeNotIndexable(location, target.Type)
            return BoundErrorExpression(nil)
        }
        if !CheckUserIndexerAccessibility(
            indexer!!,
            requireGetter: setter == nil || requiresRead,
            requireSetter: setter != nil,
            location
        ) {
            bindValueForRecovery(elementType)
            return BoundErrorExpression(nil)
        }
        // No setter: storedType came from the writable ref getter. Review
        // finding (#4350): call that getter exactly ONCE and hoist the
        // reference it returns, so a compound assignment reads and writes the
        // same location even when the getter has side effects.
        var referenceTemp LocalVariableSymbol? = nil
        if setter == nil {
            let refGetterCall = Invariant.Required(
                refGetter,
                "a stored type without a setter comes from a ref getter",
                expression: "refGetter"
            )
            let refCall = BoundUserInstanceCallExpression(nil, receiver, refGetterCall, capturedArguments, elementType)
            let reference = BoundAddressOfExpression(nil, refCall, unmanaged: false)
            referenceTemp = DeclareRangeTemp("ref", reference.Type, reference, statements)
        }
        let ReadElement = func () BoundExpression {
            return if referenceTemp != nil {
                cast[BoundExpression](BoundDereferenceExpression(nil, BoundVariableExpression(nil, referenceTemp)))
            } else {
                BindUserIndexerRead(
                    receiver,
                    indexer!!,
                    substitution,
                    (i int32, _ TypeSymbol) -> capturedArguments[i],
                    location
                )
            }
        }
        let previous BoundVariableExpression? = CaptureMultiIndexPreviousValue(
            returnsPreviousValue,
            elementType,
            ReadElement,
            statements
        )
        let ReadCurrent = func () BoundExpression {
            return previous ?? ReadElement()
        }
        let value = conversions.BindConversion(location, bindValue(elementType, ReadCurrent), elementType)
        if value is BoundErrorExpression {
            return value
        }
        if referenceTemp != nil {
            // The hoisted managed pointer cannot survive a suspension of the
            // enclosing async method, exactly as for a ref-returning call target.
            if AsyncBoundTreeQueries.HasAwait(value) {
                Diagnostics.ReportManagedReference(
                    location,
                    "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target"
                )
                return BoundErrorExpression(nil)
            }
            return FinishMultiIndexWrite(
                statements,
                BoundIndirectAssignmentExpression(nil, BoundVariableExpression(nil, referenceTemp), value),
                previous
            )
        }
        let valueLocal = DeclareRangeTemp("value", elementType, value, statements)
        let valueRead = BoundVariableExpression(nil, valueLocal)
        statements.Add(
            BoundExpressionStatement(
                nil,
                BoundUserInstanceCallExpression(
                    nil,
                    receiver,
                    Invariant.Required(
                        setter,
                        "without a hoisted reference the indexer has a setter",
                        expression: "setter"
                    ),
                    capturedArguments.Add(valueRead)
                )
            )
        )
        return BoundBlockExpression(nil, statements.ToImmutable(), previous ?? valueRead)
    }

    private func CheckUserIndexerAccessibility(
        indexer PropertySymbol,
        requireGetter bool,
        requireSetter bool,
        location TextLocation
    ) bool {
        let Check = func (accessor FunctionSymbol, accessibility Accessibility) bool {
            if AccessibilityChecker.IsAccessible(accessibility, accessor.ReceiverType, function) {
                return true
            }
            Diagnostics.ReportMemberInaccessible(
                location,
                indexer.Name,
                Invariant.Required(
                    accessor.ReceiverType,
                    "a source indexer accessor has a receiver type",
                    expression: "accessor.ReceiverType"
                )
                    .Name,
                accessibility
            )
            return false
        }
        if requireSetter &&
            !Check(
            Invariant.Required(
                indexer.SetterSymbol,
                "a required source indexer setter exists",
                expression: "indexer.SetterSymbol"
            ),
            indexer.SetterAccessibility
        ) {
            return false
        }
        return !requireGetter ||
            Check(
            Invariant.Required(
                indexer.GetterSymbol,
                "a required source indexer getter exists",
                expression: "indexer.GetterSymbol"
            ),
            indexer.GetterAccessibility
        )
    }

    // Issue #4350 (review): a postfix `t[a, b]++` reads the element once into
    // a temporary that both feeds the incremented value and is the result.
    private func CaptureMultiIndexPreviousValue(
        returnsPreviousValue bool,
        elementType TypeSymbol,
        readElement() -> BoundExpression,
        statements ImmutableArray[BoundStatement].Builder
    ) BoundVariableExpression? -> if returnsPreviousValue {
        BoundVariableExpression(nil, DeclareRangeTemp("previous", elementType, readElement(), statements))
    } else {
        default(BoundVariableExpression?)
    }

    /// Issue #4350: a write through a multi-parameter IMPORTED indexer
    /// (`slice[i, fromEnd] = v` over the runtime's
    /// `Slice<T>.this[int, bool]`). The receiver and every argument
    /// are evaluated once; a setter-less `ref`-returning indexer is written
    /// through the reference its getter returns, which a compound assignment
    /// also reads, so the getter runs exactly once.
    /// @param target The indexed receiver.
    /// @param clrTarget The receiver's CLR type.
    /// @param indexSyntaxes The written index arguments.
    /// @param bindValue Binds the stored value given the element type and a read of the current element.
    /// @param location The location for diagnostics.
    /// @param returnsPreviousValue Whether the result is the element's previous value (postfix
    /// increment/decrement).
    /// @returns The bound assignment, or `null` when no imported indexer applies.
    private func TryBindMultiIndexClrAssignment(
        target BoundExpression,
        clrTarget Type,
        indexSyntaxes GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        bindValue(TypeSymbol, () -> BoundExpression) -> BoundExpression,
        location TextLocation,
        returnsPreviousValue bool
    ) BoundExpression? {
        let bound = ImmutableArray.CreateBuilder[BoundExpression](indexSyntaxes.Count)
        for indexSyntax in indexSyntaxes {
            bound.Add(BindExpression(indexSyntax))
        }
        let outcome = memberLookup.TryResolveClrIndexer(
            target.Type,
            clrTarget,
            bound.MoveToImmutable(),
            out var indexer,
            out var resolvedArguments
        )
        if outcome != ClrIndexerResolutionOutcome.Resolved || indexer == nil {
            return if ReportClrIndexerResolutionFailure(outcome, location) {
                BoundErrorExpression(nil)
            } else {
                default(BoundErrorExpression?)
            }
        }
        let elementType = if target.Type is ImportedTypeSymbol importedTarget {
            MapErasedIndexerElementType(importedTarget, indexer)
        } else {
            MemberLookup.GetClrPropertyTypeSymbol(target.Type, indexer)
        }
        // Review finding (#4350): only a writable `ref` return is written
        // through; a `ref readonly` indexer (`ReadOnlySlice<T>.this[int, bool]`)
        // is read-only exactly as on the single-index path.
        let isRefIndexer = elementType is ByRefTypeSymbol && RefCapabilities.GetReturnRefKind(indexer) == RefKind.Ref
        let visibleSetter MethodInfo? = ClrMemberVisibility.GetVisibleSetter(
            indexer,
            CanAccessInternalsOf(indexer.DeclaringType)
        )
        if !isRefIndexer && visibleSetter == nil {
            Diagnostics.ReportCannotAssign(location, "this[]")
            return BoundErrorExpression(nil)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        var receiver = target
        if !(target is BoundVariableExpression) {
            let receiverLocal = DeclareRangeTemp("receiver", target.Type, target, statements)
            receiver = BoundVariableExpression(nil, receiverLocal)
        }
        let converted = BindClrIndexerArguments(target.Type, indexer, resolvedArguments, location)
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](converted.Length)
        for argument in converted {
            let argumentLocal = DeclareRangeTemp("index", argument.Type, argument, statements)
            arguments.Add(BoundVariableExpression(nil, argumentLocal))
        }
        let capturedArguments = arguments.MoveToImmutable()
        if isRefIndexer && elementType is ByRefTypeSymbol byRef {
            let reference = BoundClrIndexExpression(nil, receiver, indexer, capturedArguments, elementType)
            let referenceTemp = DeclareRangeTemp("ref", reference.Type, reference, statements)
            let ReadThroughReference = func () BoundExpression {
                return BoundDereferenceExpression(nil, BoundVariableExpression(nil, referenceTemp))
            }
            let previousThroughReference BoundVariableExpression? = CaptureMultiIndexPreviousValue(
                returnsPreviousValue,
                byRef.PointeeType,
                ReadThroughReference,
                statements
            )
            let ReadCurrentThroughReference = func () BoundExpression {
                return previousThroughReference ?? ReadThroughReference()
            }
            let refValue = conversions.BindConversion(
                location,
                bindValue(byRef.PointeeType, ReadCurrentThroughReference),
                byRef.PointeeType
            )
            if refValue is BoundErrorExpression {
                return refValue
            }
            if AsyncBoundTreeQueries.HasAwait(refValue) {
                Diagnostics.ReportManagedReference(
                    location,
                    "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target"
                )
                return BoundErrorExpression(nil)
            }
            return FinishMultiIndexWrite(
                statements,
                BoundIndirectAssignmentExpression(nil, BoundVariableExpression(nil, referenceTemp), refValue),
                previousThroughReference
            )
        }
        let ReadElement = func () BoundExpression {
            return BoundClrIndexExpression(nil, receiver, indexer!!, capturedArguments, elementType)
        }
        let previous BoundVariableExpression? = CaptureMultiIndexPreviousValue(
            returnsPreviousValue,
            elementType,
            ReadElement,
            statements
        )
        let ReadCurrent = func () BoundExpression {
            return previous ?? ReadElement()
        }
        let value = conversions.BindConversion(location, bindValue(elementType, ReadCurrent), elementType)
        if value is BoundErrorExpression {
            return value
        }
        let valueLocal = DeclareRangeTemp("value", elementType, value, statements)
        let valueRead = BoundVariableExpression(nil, valueLocal)
        statements.Add(
            BoundExpressionStatement(
                nil,
                BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    nil,
                    receiver,
                    indexer,
                    capturedArguments,
                    valueRead,
                    elementType
                )
            )
        )
        return BoundBlockExpression(nil, statements.ToImmutable(), previous ?? valueRead)
    }

    // Issue #4350 (review): an indexer inherited from a constructed base is
    // called on the receiver viewed as that base (an implicit reference
    // upcast), so its accessor is emitted against the base's TypeSpec.
    private func ViewIndexerReceiver(
        target BoundExpression,
        view TypeSymbol?,
        location TextLocation
    ) BoundExpression -> if view == nil ||
        object.ReferenceEquals(view, target.Type) {
        target
    } else {
        conversions.BindConversion(location, target, view)
    }

    // Issue #4350 (review): the declared defaults of an indexer's trailing
    // optional parameters beyond the `writtenCount` written arguments.
    private func TrailingIndexerDefaults(
        indexer PropertySymbol,
        writtenCount int32,
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]?
    ) ImmutableArray[BoundExpression] {
        let defaults = ImmutableArray.CreateBuilder[BoundExpression]()
        for var i = writtenCount; i < indexer.Parameters.Length; i++ {
            defaults.Add(
                IndexerDefaultArgument(
                    indexer.Parameters[i],
                    SubstituteIndexerType(indexer.Parameters[i].Type, substitution)
                )
            )
        }
        return defaults.ToImmutable()
    }

    private func SubstituteIndexerType(
        type TypeSymbol,
        substitution Dictionary[TypeParameterSymbol, TypeSymbol]?
    ) TypeSymbol -> if substitution != nil {
        Binder.SubstituteType(type, substitution, $scope.References!!.MapClrTypeToReferences)
    } else {
        type
    }

    /// A visible user indexer and the substitution from its declaring level's
    /// type parameters to the receiver's type arguments.
    /// @param Indexer The OPEN indexer definition.
    /// @param Substitution The declaring level's substitution, if any.
    /// @param View The constructed base type the receiver is viewed as, when the indexer is inherited from
    /// one.
    private data struct VisibleUserIndexer(
        Indexer PropertySymbol,
        Substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
        View TypeSymbol?
    ) : IEquatable[VisibleUserIndexer] { }

    shared {
        private func MergeSubstitutions(
            first Dictionary[TypeParameterSymbol, TypeSymbol]?,
            second Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) Dictionary[TypeParameterSymbol, TypeSymbol]? {
            if first == nil {
                return second
            }
            if second == nil {
                return first
            }
            let merged = Dictionary[TypeParameterSymbol, TypeSymbol](first)
            for entry in second {
                merged[entry.Key] = entry.Value
            }
            return merged
        }

        // A write through a hoisted reference yields the stored value, or the
        // captured previous value for a postfix increment/decrement.
        private func FinishMultiIndexWrite(
            statements ImmutableArray[BoundStatement].Builder,
            write BoundExpression,
            previous BoundVariableExpression?
        ) BoundExpression {
            if previous == nil {
                return BoundBlockExpression(nil, statements.ToImmutable(), write)
            }
            statements.Add(BoundExpressionStatement(nil, write))
            return BoundBlockExpression(nil, statements.ToImmutable(), previous)
        }

        // Issue #4350 (review): an indexer accepts `argumentCount` written
        // arguments when its extra trailing parameters all declare defaults,
        // exactly as a C# optional indexer parameter does.
        private func AcceptsIndexArgumentCount(candidate PropertySymbol, argumentCount int32) bool {
            if candidate.Parameters.Length < argumentCount {
                return false
            }
            for var i = argumentCount; i < candidate.Parameters.Length; i++ {
                if !candidate.Parameters[i].HasExplicitDefaultValue {
                    return false
                }
            }
            return true
        }

        private func IndexerDefaultArgument(
            parameter ParameterSymbol,
            parameterType TypeSymbol
        ) BoundExpression -> if parameter.ExplicitDefaultValue == nil {
            cast[BoundExpression](BoundDefaultExpression(nil, parameterType))
        } else {
            cast[BoundExpression](BoundLiteralExpression(nil, parameter.ExplicitDefaultValue, parameterType))
        }
    }
}
