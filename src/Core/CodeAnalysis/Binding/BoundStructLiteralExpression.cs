// <copyright file="BoundStructLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A struct composite literal: <c>Point{X: 1, Y: 2}</c> (Phase 3.B.1).
/// </summary>
public sealed class BoundStructLiteralExpression : BoundExpression
{
    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers)
        : this(syntax, structType, initializers, null)
    {
    }

    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers, BoundExpression? copySource)
        : this(syntax, structType, initializers, copySource, isZeroInitialization: false)
    {
    }

    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers, BoundExpression? copySource, bool isZeroInitialization)
        : base(syntax)
    {
        if (copySource != null && (!structType.IsData || !initializers.IsEmpty))
        {
            throw new System.ArgumentException("A copy literal must be a data type without member initializers.", nameof(copySource));
        }

        StructType = structType;
        CopySource = copySource;
        IsZeroInitialization = isZeroInitialization;
        Initializers = CallsPrimaryConstructor
            ? PreparePrimaryArguments(
                syntax,
                structType,
                initializers.Where(initializer => !initializer.IsDeclarationInitializer).ToImmutableArray())
            : initializers;
    }

    public StructSymbol StructType { get; }

    public ImmutableArray<BoundFieldInitializer> Initializers { get; }

    /// <summary>
    /// Gets the whole-value copy or class-clone source, when this expression
    /// materializes a native data copy rather than constructing a new value.
    /// </summary>
    public BoundExpression? CopySource { get; }

    /// <summary>
    /// Gets a value indicating whether this literal supplies only sound collection zero values
    /// for an omitted initializer, rather than explicitly constructing a value.
    /// </summary>
    public bool IsZeroInitialization { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.StructLiteralExpression;

    internal bool CallsPrimaryConstructor => !IsZeroInitialization && CopySource == null
        && StructType.ClrType == null
        && (StructType.Definition ?? StructType).IsData
        && (StructType.Definition ?? StructType).HasDeclaredPrimaryConstructor;

    internal static ImmutableArray<BoundFieldInitializer> PreparePrimaryArguments(
        SyntaxNode? syntax,
        StructSymbol type,
        ImmutableArray<BoundFieldInitializer> initializers)
    {
        ImmutableArray<BoundFieldInitializer>.Builder? builder = null;
        foreach (var parameter in type.PrimaryConstructorParameters)
        {
            var member = Invariant.Required(GetPrimaryMember(type, parameter.Name), "a primary argument has an own field or property");
            if (initializers.Any(initializer => initializer.Field == member || initializer.Property == member))
            {
                continue;
            }

            // Defaults are children of the bound literal, so rewriting and
            // slot planning see exactly the nodes that emission will consume.
            var value = MagicCollectionZeroValue.TrySynthesizeEmptyInstance(syntax, parameter.Type)
                ?? new BoundDefaultExpression(syntax, parameter.Type);
            builder ??= initializers.ToBuilder();
            builder.Add(member is FieldSymbol field
                ? new BoundFieldInitializer(field, value)
                : new BoundFieldInitializer(Invariant.Required(member as PropertySymbol, "a primary member is a field or property"), value));
        }

        return builder?.ToImmutable() ?? initializers;
    }

    internal BoundFieldInitializer? GetPrimaryArgument(string name)
    {
        var member = GetPrimaryMember(StructType, name);
        foreach (var initializer in Initializers)
        {
            if ((initializer.Property != null && initializer.Property == member)
                || (initializer.Field != null && initializer.Field == member))
            {
                return initializer;
            }
        }

        return null;
    }

    internal static Symbol? GetPrimaryMember(StructSymbol type, string name)
    {
        foreach (var parameter in type.PrimaryConstructorParameters)
        {
            if (parameter.Name == name)
            {
                return TypeMemberModel.LookupMember(
                    type,
                    name,
                    new MemberQuery(includeInstance: true, includeStatic: false, includeInherited: false, MemberKinds.Property | MemberKinds.Field));
            }
        }

        return null;
    }

    internal static bool IsStagedConstruction(BoundBlockExpression block)
    {
        if (block.Statements.IsDefaultOrEmpty || block.Expression is not BoundStructLiteralExpression)
        {
            return false;
        }

        foreach (var statement in block.Statements)
        {
            if (statement is not BoundVariableDeclaration { Initializer: not null })
            {
                return false;
            }
        }

        return true;
    }

    internal ImmutableArray<(FieldSymbol Field, BoundExpression Value, bool IsSupplied)> GetPrimaryConstructorArguments()
    {
        // Imported positional literals already carry their CLR constructor's
        // property arguments; they do not have compiler-owned storage fields.
        if (StructType.ClrType != null)
        {
            return ImmutableArray<(FieldSymbol Field, BoundExpression Value, bool IsSupplied)>.Empty;
        }

        var arguments = ImmutableArray.CreateBuilder<(FieldSymbol Field, BoundExpression Value, bool IsSupplied)>(
            StructType.PrimaryConstructorParameters.Length);
        foreach (var parameter in StructType.PrimaryConstructorParameters)
        {
            ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(StructType, parameter.Name, out var field);
            if (field == null)
            {
                continue;
            }

            var storage = field;
            var initializer = Initializers.FirstOrDefault(
                candidate => candidate.Field == storage || candidate.Property?.BackingField == storage);
            arguments.Add((storage, initializer?.Value ?? new BoundDefaultExpression(Syntax, storage.Type), initializer != null));
        }

        return arguments.ToImmutable();
    }
}
