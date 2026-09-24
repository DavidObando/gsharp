// <copyright file="ExpressionBinder.UserIndexers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0187 / issue #4350: overload resolution for user-declared indexers.
/// A G# struct, class, or interface may declare several <c>prop this[...]</c>
/// indexers that differ by index-parameter signature, exactly like C#.
/// </summary>
internal sealed partial class ExpressionBinder
{
    /// <summary>
    /// Returns every indexer visible on <paramref name="receiverType"/>:
    /// the indexers of the receiver's own definition and of its bases, with a
    /// base indexer hidden by a more-derived indexer of the same signature
    /// (C# hide-by-signature). The returned properties are the OPEN
    /// definition members so their accessors resolve to emitted MethodDefs.
    /// </summary>
    /// <param name="receiverType">The indexed receiver's static type.</param>
    /// <returns>The visible indexers, most-derived first.</returns>
    private static ImmutableArray<PropertySymbol> GetVisibleUserIndexers(TypeSymbol receiverType)
    {
        var builder = ImmutableArray.CreateBuilder<PropertySymbol>();

        void AddLevel(ImmutableArray<PropertySymbol> properties)
        {
            foreach (var property in properties)
            {
                // Review finding (#4350): an explicit-interface indexer
                // (`prop (IRepo) this[...]`) is reachable only through its
                // interface, never by indexing the implementing type.
                if (!property.IsIndexer || property.HasExplicitInterfaceClause)
                {
                    continue;
                }

                var hidden = false;
                foreach (var existing in builder)
                {
                    if (DeclarationBinder.HaveSameIndexerSignature(existing.Parameters, property.Parameters))
                    {
                        hidden = true;
                        break;
                    }
                }

                if (!hidden)
                {
                    builder.Add(property);
                }
            }
        }

        switch (receiverType)
        {
            case StructSymbol structType:
                foreach (var level in (structType.Definition ?? structType).GetHierarchy())
                {
                    AddLevel(level.Properties);
                }

                break;
            case InterfaceSymbol interfaceType:
                foreach (var level in interfaceType.SelfAndAllBaseInterfaces())
                {
                    AddLevel((level.Definition ?? level).Properties);
                }

                break;
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Selects the user indexer an index access with
    /// <paramref name="argumentCount"/> arguments binds to.
    /// </summary>
    /// <param name="receiverType">The indexed receiver's static type.</param>
    /// <param name="argumentCount">The number of index arguments written.</param>
    /// <param name="bindArguments">Binds the index arguments; called only when
    /// more than one indexer of the right arity remains, so a single-candidate
    /// access keeps target-typed argument binding.</param>
    /// <param name="location">The location used for resolution diagnostics.</param>
    /// <param name="indexer">The selected OPEN indexer.</param>
    /// <param name="substitution">The receiver's type-parameter substitution, if any.</param>
    /// <param name="boundArguments">The pre-bound arguments, or default when not bound.</param>
    /// <param name="reported">Whether a resolution diagnostic was reported.</param>
    /// <returns><see langword="true"/> when an indexer was selected.</returns>
    private bool TryResolveUserIndexer(
        TypeSymbol receiverType,
        int argumentCount,
        Func<ImmutableArray<BoundExpression>> bindArguments,
        TextLocation location,
        [NotNullWhen(true)] out PropertySymbol? indexer,
        out Dictionary<TypeParameterSymbol, TypeSymbol>? substitution,
        out ImmutableArray<BoundExpression> boundArguments,
        out bool reported)
    {
        indexer = null;
        substitution = null;
        boundArguments = default;
        reported = false;

        var visible = GetVisibleUserIndexers(receiverType);
        if (visible.IsEmpty)
        {
            return false;
        }

        substitution = receiverType switch
        {
            StructSymbol structType when TryGetUserIndexer(structType, out _, out var structSubstitution) => structSubstitution,
            InterfaceSymbol interfaceType when TryGetUserIndexer(interfaceType, out _, out var interfaceSubstitution) => interfaceSubstitution,
            _ => null,
        };

        var arityMatches = ImmutableArray.CreateBuilder<PropertySymbol>();
        foreach (var candidate in visible)
        {
            if (AcceptsIndexArgumentCount(candidate, argumentCount))
            {
                arityMatches.Add(candidate);
            }
        }

        if (arityMatches.Count == 0)
        {
            if (visible.Length > 1)
            {
                _ = bindArguments();
                Diagnostics.ReportNoApplicableOverload(location, "this[]");
                reported = true;
            }

            return false;
        }

        if (arityMatches.Count == 1)
        {
            indexer = arityMatches[0];
            return true;
        }

        boundArguments = bindArguments();
        foreach (var argument in boundArguments)
        {
            if (argument is BoundErrorExpression || argument.Type == TypeSymbol.Error)
            {
                reported = true;
                return false;
            }
        }

        // Rank the candidates through the ordinary user-overload resolver by
        // presenting each indexer as a synthetic function over its (receiver-
        // substituted) index parameters.
        var synthetic = ImmutableArray.CreateBuilder<FunctionSymbol>(arityMatches.Count);
        var byFunction = new Dictionary<FunctionSymbol, PropertySymbol>(arityMatches.Count);
        foreach (var candidate in arityMatches)
        {
            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>(candidate.Parameters.Length);
            foreach (var parameter in candidate.Parameters)
            {
                var syntheticParameter = new ParameterSymbol(
                    parameter.Name,
                    SubstituteIndexerType(parameter.Type, substitution),
                    refKind: parameter.RefKind);
                if (parameter.HasExplicitDefaultValue)
                {
                    syntheticParameter.SetExplicitDefaultValue(parameter.ExplicitDefaultValue);
                }

                parameters.Add(syntheticParameter);
            }

            var function = new FunctionSymbol("this[]", parameters.MoveToImmutable(), SubstituteIndexerType(candidate.Type, substitution));
            synthetic.Add(function);
            byFunction[function] = candidate;
        }

        var selected = overloads.SelectBestInstanceOverload(
            synthetic.MoveToImmutable(),
            argumentCount,
            argumentNames: default,
            boundArguments,
            out var ambiguous,
            out _);
        if (selected == null)
        {
            if (ambiguous)
            {
                Diagnostics.ReportAmbiguousOverloadResolution(location, "this[]");
            }
            else
            {
                Diagnostics.ReportNoApplicableOverload(location, "this[]");
            }

            reported = true;
            return false;
        }

        indexer = byFunction[selected];
        return true;
    }

    /// <summary>
    /// Selects a user indexer that takes exactly one index parameter of the
    /// given CLR type (for the <c>System.Index</c> / <c>System.Range</c> value
    /// paths, which C# binds to such an indexer when one is declared).
    /// </summary>
    /// <param name="receiverType">The indexed receiver's static type.</param>
    /// <param name="parameterClrType">The required index-parameter CLR type.</param>
    /// <param name="indexer">The matching OPEN indexer.</param>
    /// <param name="substitution">The receiver's type-parameter substitution, if any.</param>
    /// <returns><see langword="true"/> when such an indexer is declared.</returns>
    private bool TryGetUserIndexerTaking(
        TypeSymbol receiverType,
        Type parameterClrType,
        [NotNullWhen(true)] out PropertySymbol? indexer,
        out Dictionary<TypeParameterSymbol, TypeSymbol>? substitution)
    {
        indexer = null;
        substitution = receiverType switch
        {
            StructSymbol structType when TryGetUserIndexer(structType, out _, out var structSubstitution) => structSubstitution,
            InterfaceSymbol interfaceType when TryGetUserIndexer(interfaceType, out _, out var interfaceSubstitution) => interfaceSubstitution,
            _ => null,
        };

        foreach (var candidate in GetVisibleUserIndexers(receiverType))
        {
            if (candidate.Parameters.Length == 1
                && ClrTypeUtilities.AreSame(SubstituteIndexerType(candidate.Parameters[0].Type, substitution).ClrType, parameterClrType))
            {
                indexer = candidate;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Binds a read of a selected user indexer: converts each index argument
    /// to its (substituted) parameter type and calls the getter.
    /// </summary>
    /// <param name="target">The indexed receiver.</param>
    /// <param name="indexer">The selected OPEN indexer.</param>
    /// <param name="substitution">The receiver's type-parameter substitution.</param>
    /// <param name="convert">Converts argument <c>i</c> to the given parameter type.</param>
    /// <param name="targetLocation">The receiver location for diagnostics.</param>
    /// <param name="writtenArgumentCount">How many index arguments were written;
    /// trailing optional parameters beyond them take their declared defaults.</param>
    /// <returns>The bound getter call, or an error when the indexer has no getter.</returns>
    private BoundExpression BindUserIndexerRead(
        BoundExpression target,
        PropertySymbol indexer,
        Dictionary<TypeParameterSymbol, TypeSymbol>? substitution,
        Func<int, TypeSymbol, BoundExpression> convert,
        TextLocation targetLocation,
        int? writtenArgumentCount = null)
    {
        var argumentCount = writtenArgumentCount ?? indexer.Parameters.Length;
        if (indexer.GetterSymbol == null)
        {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
            return new BoundErrorExpression(null);
        }

        var arguments = ImmutableArray.CreateBuilder<BoundExpression>(indexer.Parameters.Length);
        for (var i = 0; i < indexer.Parameters.Length; i++)
        {
            var parameterType = SubstituteIndexerType(indexer.Parameters[i].Type, substitution);
            arguments.Add(i < argumentCount
                ? convert(i, parameterType)
                : IndexerDefaultArgument(indexer.Parameters[i], parameterType));
        }

        return new BoundUserInstanceCallExpression(
            null,
            target,
            indexer.GetterSymbol,
            arguments.MoveToImmutable(),
            SubstituteIndexerType(indexer.Type, substitution));
    }

    /// <summary>
    /// Binds <c>target[a, b, …] = value</c> (or a compound form) against a
    /// multi-parameter user indexer: the arguments are evaluated once, left to
    /// right, and the value is stored through the selected setter, or through
    /// a writable ref-returning getter when the indexer has no setter.
    /// </summary>
    /// <param name="target">The indexed receiver.</param>
    /// <param name="indexSyntaxes">The written index arguments.</param>
    /// <param name="bindValue">Binds the stored value given the element type
    /// and a read of the current element (for compound assignment).</param>
    /// <param name="location">The location for diagnostics.</param>
    /// <returns>The bound assignment, or <see langword="null"/> when the target
    /// declares no user indexer (the caller keeps its rectangular-array path).</returns>
    private BoundExpression? TryBindMultiIndexUserAssignment(
        BoundExpression target,
        SeparatedSyntaxList<ExpressionSyntax> indexSyntaxes,
        Func<TypeSymbol, Func<BoundExpression>, BoundExpression> bindValue,
        TextLocation location)
    {
        if (target.Type is ImportedTypeSymbol or NullabilityAnnotatedTypeSymbol
            && target.Type.ClrType is { } clrTarget)
        {
            return TryBindMultiIndexClrAssignment(target, clrTarget, indexSyntaxes, bindValue, location);
        }

        if (target.Type is not (StructSymbol or InterfaceSymbol))
        {
            return null;
        }

        ImmutableArray<BoundExpression> BindAll()
        {
            var bound = ImmutableArray.CreateBuilder<BoundExpression>(indexSyntaxes.Count);
            foreach (var indexSyntax in indexSyntaxes)
            {
                bound.Add(BindExpression(indexSyntax));
            }

            return bound.MoveToImmutable();
        }

        if (!TryResolveUserIndexer(
            target.Type,
            indexSyntaxes.Count,
            BindAll,
            location,
            out var selected,
            out var substitution,
            out var preBound,
            out var reported))
        {
            return reported ? new BoundErrorExpression(null) : null;
        }

        var indexer = selected;
        if (RefCapabilities.IsReadOnlyValueReference(target))
        {
            Diagnostics.ReportCannotAssign(location, "this[]");
            return new BoundErrorExpression(null);
        }

        var setter = indexer.SetterSymbol;
        var refGetter = setter == null
            && target.Type is StructSymbol
            && indexer.GetterSymbol is { ReturnRefKind: RefKind.Ref } getter
                ? getter
                : null;
        var storedType = refGetter?.Type ?? setter?.Parameters[^1].Type;
        if (storedType == null)
        {
            Diagnostics.ReportTypeNotIndexable(location, target.Type);
            return new BoundErrorExpression(null);
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var receiver = target;
        if (target is not BoundVariableExpression)
        {
            var receiverLocal = DeclareRangeTemp("receiver", target.Type, target, statements);
            receiver = new BoundVariableExpression(null, receiverLocal);
        }

        var arguments = ImmutableArray.CreateBuilder<BoundExpression>(indexer.Parameters.Length);
        for (var i = 0; i < indexer.Parameters.Length; i++)
        {
            var parameterType = SubstituteIndexerType(indexer.Parameters[i].Type, substitution);
            var converted = i >= indexSyntaxes.Count
                ? IndexerDefaultArgument(indexer.Parameters[i], parameterType)
                : preBound.IsDefault
                    ? conversions.BindConversion(indexSyntaxes[i], parameterType)
                    : conversions.BindConversion(indexSyntaxes[i].Location, preBound[i], parameterType);
            var argumentLocal = DeclareRangeTemp("index", parameterType, converted, statements);
            arguments.Add(new BoundVariableExpression(null, argumentLocal));
        }

        var capturedArguments = arguments.MoveToImmutable();
        var elementType = SubstituteIndexerType(storedType, substitution);

        // No setter: storedType came from the writable ref getter. Review
        // finding (#4350): call that getter exactly ONCE and hoist the
        // reference it returns, so a compound assignment reads and writes the
        // same location even when the getter has side effects.
        LocalVariableSymbol? referenceTemp = null;
        if (setter == null)
        {
            var refGetterCall = Invariant.Required(refGetter, "a stored type without a setter comes from a ref getter");
            var refCall = new BoundUserInstanceCallExpression(null, receiver, refGetterCall, capturedArguments, elementType);
            var reference = new BoundAddressOfExpression(null, refCall, unmanaged: false);
            referenceTemp = DeclareRangeTemp("ref", reference.Type, reference, statements);
        }

        BoundExpression ReadCurrent()
            => referenceTemp != null
                ? new BoundDereferenceExpression(null, new BoundVariableExpression(null, referenceTemp))
                : BindUserIndexerRead(receiver, indexer, substitution, (i, _) => capturedArguments[i], location);

        var value = conversions.BindConversion(location, bindValue(elementType, ReadCurrent), elementType);
        if (value is BoundErrorExpression)
        {
            return value;
        }

        if (referenceTemp != null)
        {
            // The hoisted managed pointer cannot survive a suspension of the
            // enclosing async method, exactly as for a ref-returning call target.
            if (GSharp.Core.CodeAnalysis.Lowering.Async.AsyncBoundTreeQueries.HasAwait(value))
            {
                Diagnostics.ReportManagedReference(
                    location,
                    "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target");
                return new BoundErrorExpression(null);
            }

            return new BoundBlockExpression(
                null,
                statements.ToImmutable(),
                new BoundIndirectAssignmentExpression(null, new BoundVariableExpression(null, referenceTemp), value));
        }

        var valueLocal = DeclareRangeTemp("value", elementType, value, statements);
        var valueRead = new BoundVariableExpression(null, valueLocal);
        statements.Add(new BoundExpressionStatement(
            null,
            new BoundUserInstanceCallExpression(
                null,
                receiver,
                Invariant.Required(setter, "without a hoisted reference the indexer has a setter"),
                capturedArguments.Add(valueRead))));
        return new BoundBlockExpression(null, statements.ToImmutable(), valueRead);
    }

    /// <summary>
    /// Issue #4350: a write through a multi-parameter IMPORTED indexer
    /// (<c>slice[i, fromEnd] = v</c> over the runtime's
    /// <c>Slice&lt;T&gt;.this[int, bool]</c>). The receiver and every argument
    /// are evaluated once; a setter-less <c>ref</c>-returning indexer is written
    /// through the reference its getter returns, which a compound assignment
    /// also reads, so the getter runs exactly once.
    /// </summary>
    /// <param name="target">The indexed receiver.</param>
    /// <param name="clrTarget">The receiver's CLR type.</param>
    /// <param name="indexSyntaxes">The written index arguments.</param>
    /// <param name="bindValue">Binds the stored value given the element type and a read of the current element.</param>
    /// <param name="location">The location for diagnostics.</param>
    /// <returns>The bound assignment, or <see langword="null"/> when no imported indexer applies.</returns>
    private BoundExpression? TryBindMultiIndexClrAssignment(
        BoundExpression target,
        Type clrTarget,
        SeparatedSyntaxList<ExpressionSyntax> indexSyntaxes,
        Func<TypeSymbol, Func<BoundExpression>, BoundExpression> bindValue,
        TextLocation location)
    {
        var bound = ImmutableArray.CreateBuilder<BoundExpression>(indexSyntaxes.Count);
        foreach (var indexSyntax in indexSyntaxes)
        {
            bound.Add(BindExpression(indexSyntax));
        }

        var outcome = memberLookup.TryResolveClrIndexer(
            target.Type,
            clrTarget,
            bound.MoveToImmutable(),
            out var indexer,
            out var resolvedArguments);
        if (outcome != ClrIndexerResolutionOutcome.Resolved || indexer == null)
        {
            return ReportClrIndexerResolutionFailure(outcome, location) ? new BoundErrorExpression(null) : null;
        }

        var elementType = target.Type is ImportedTypeSymbol importedTarget
            ? MapErasedIndexerElementType(importedTarget, indexer)
            : MemberLookup.GetClrPropertyTypeSymbol(target.Type, indexer);
        var isRefIndexer = elementType is ByRefTypeSymbol;
        var visibleSetter = ClrMemberVisibility.GetVisibleSetter(indexer, CanAccessInternalsOf(indexer.DeclaringType));
        if (!isRefIndexer && visibleSetter == null)
        {
            Diagnostics.ReportCannotAssign(location, "this[]");
            return new BoundErrorExpression(null);
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var receiver = target;
        if (target is not BoundVariableExpression)
        {
            var receiverLocal = DeclareRangeTemp("receiver", target.Type, target, statements);
            receiver = new BoundVariableExpression(null, receiverLocal);
        }

        var converted = BindClrIndexerArguments(target.Type, indexer, resolvedArguments, location);
        var arguments = ImmutableArray.CreateBuilder<BoundExpression>(converted.Length);
        foreach (var argument in converted)
        {
            var argumentLocal = DeclareRangeTemp("index", argument.Type, argument, statements);
            arguments.Add(new BoundVariableExpression(null, argumentLocal));
        }

        var capturedArguments = arguments.MoveToImmutable();
        if (elementType is ByRefTypeSymbol byRef)
        {
            var reference = new BoundClrIndexExpression(null, receiver, indexer, capturedArguments, elementType);
            var referenceTemp = DeclareRangeTemp("ref", reference.Type, reference, statements);
            BoundExpression ReadThroughReference()
                => new BoundDereferenceExpression(null, new BoundVariableExpression(null, referenceTemp));

            var refValue = conversions.BindConversion(location, bindValue(byRef.PointeeType, ReadThroughReference), byRef.PointeeType);
            if (refValue is BoundErrorExpression)
            {
                return refValue;
            }

            if (GSharp.Core.CodeAnalysis.Lowering.Async.AsyncBoundTreeQueries.HasAwait(refValue))
            {
                Diagnostics.ReportManagedReference(
                    location,
                    "a ref-returning assignment target cannot survive suspension; evaluate the value before selecting the target");
                return new BoundErrorExpression(null);
            }

            return new BoundBlockExpression(
                null,
                statements.ToImmutable(),
                new BoundIndirectAssignmentExpression(null, new BoundVariableExpression(null, referenceTemp), refValue));
        }

        BoundExpression ReadCurrent()
            => new BoundClrIndexExpression(null, receiver, indexer, capturedArguments, elementType);

        var value = conversions.BindConversion(location, bindValue(elementType, ReadCurrent), elementType);
        if (value is BoundErrorExpression)
        {
            return value;
        }

        var valueLocal = DeclareRangeTemp("value", elementType, value, statements);
        var valueRead = new BoundVariableExpression(null, valueLocal);
        statements.Add(new BoundExpressionStatement(
            null,
            BoundClrIndexAssignmentExpression.WithExpressionTarget(null, receiver, indexer, capturedArguments, valueRead, elementType)));
        return new BoundBlockExpression(null, statements.ToImmutable(), valueRead);
    }

    // Issue #4350 (review): an indexer accepts `argumentCount` written
    // arguments when its extra trailing parameters all declare defaults,
    // exactly as a C# optional indexer parameter does.
    private static bool AcceptsIndexArgumentCount(PropertySymbol candidate, int argumentCount)
    {
        if (candidate.Parameters.Length < argumentCount)
        {
            return false;
        }

        for (var i = argumentCount; i < candidate.Parameters.Length; i++)
        {
            if (!candidate.Parameters[i].HasExplicitDefaultValue)
            {
                return false;
            }
        }

        return true;
    }

    // Issue #4350 (review): the declared defaults of an indexer's trailing
    // optional parameters beyond the `writtenCount` written arguments.
    private ImmutableArray<BoundExpression> TrailingIndexerDefaults(
        PropertySymbol indexer,
        int writtenCount,
        Dictionary<TypeParameterSymbol, TypeSymbol>? substitution)
    {
        var defaults = ImmutableArray.CreateBuilder<BoundExpression>();
        for (var i = writtenCount; i < indexer.Parameters.Length; i++)
        {
            defaults.Add(IndexerDefaultArgument(
                indexer.Parameters[i],
                SubstituteIndexerType(indexer.Parameters[i].Type, substitution)));
        }

        return defaults.ToImmutable();
    }

    private static BoundExpression IndexerDefaultArgument(ParameterSymbol parameter, TypeSymbol parameterType)
        => parameter.ExplicitDefaultValue == null
            ? new BoundDefaultExpression(null, parameterType)
            : new BoundLiteralExpression(null, parameter.ExplicitDefaultValue, parameterType);

    private TypeSymbol SubstituteIndexerType(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol>? substitution)
        => substitution != null
            ? Binder.SubstituteType(type, substitution, scope.References.MapClrTypeToReferences)
            : type;
}
