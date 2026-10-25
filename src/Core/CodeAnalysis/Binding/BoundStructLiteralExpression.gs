// <copyright file="BoundStructLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq

/// A struct composite literal: `Point{X: 1, Y: 2}` (Phase 3.B.1).
class BoundStructLiteralExpression : BoundExpression {
    convenience init(syntax SyntaxNode?, structType StructSymbol, initializers ImmutableArray[BoundFieldInitializer]) {
        init(syntax, structType, initializers, nil)
    }

    convenience init(
        syntax SyntaxNode?,
        structType StructSymbol,
        initializers ImmutableArray[BoundFieldInitializer],
        copySource BoundExpression?
    ) {
        init(syntax, structType, initializers, copySource, false)
    }

    init(
        syntax SyntaxNode?,
        structType StructSymbol,
        initializers ImmutableArray[BoundFieldInitializer],
        copySource BoundExpression?,
        isZeroInitialization bool
    ) : base(syntax) {
        if copySource != nil && (!structType.IsData || !initializers.IsEmpty) {
            throw ArgumentException("A copy literal must be a data type without member initializers.", "copySource")
        }
        StructType = structType
        CopySource = copySource
        IsZeroInitialization = isZeroInitialization
        Initializers = if CallsPrimaryConstructor {
            PreparePrimaryArguments(
                syntax,
                structType,
                initializers.Where((initializer BoundFieldInitializer) -> !initializer.IsDeclarationInitializer)
                    .ToImmutableArray()
            )
        } else {
            initializers
        }
    }

    prop StructType StructSymbol {
        get;
    }

    prop Initializers ImmutableArray[BoundFieldInitializer] {
        get;
    }

    /// Gets the whole-value copy or class-clone source, when this expression
    /// materializes a native data copy rather than constructing a new value.
    prop CopySource BoundExpression? {
        get;
    }

    /// Gets a value indicating whether this literal supplies only sound collection zero values
    /// for an omitted initializer, rather than explicitly constructing a value.
    prop IsZeroInitialization bool {
        get;
    }

    override prop Type TypeSymbol -> StructType
    override prop Kind BoundNodeKind -> BoundNodeKind.StructLiteralExpression

    internal prop CallsPrimaryConstructor bool -> !IsZeroInitialization &&
        CopySource == nil &&
        StructType.ClrType == nil &&
        (StructType.Definition ?? StructType).IsData &&
        (StructType.Definition ?? StructType).HasDeclaredPrimaryConstructor

    /// Checks imported value-type stores after every construction path selects its initializers.
    internal func ValidateInitializerWrites(diagnostics DiagnosticBag, anchor SyntaxNode?) {
        // Class positional initializers may instead be arguments to an owning CLR constructor.
        if StructType.IsClass {
            return
        }
        for initializer in Initializers {
            if initializer.Field is not{} field ||
                CanWriteInitializerField(initializer.FieldDeclaringType ?? StructType, field) {
                continue
            }
            let syntax = Syntax ?? anchor
            let location = if syntax is StructLiteralExpressionSyntax literal {
                literal
                    .Initializers
                    .FirstOrDefault(
                    (candidate FieldInitializerSyntax) -> candidate.FieldIdentifier.ValueText == field.Name
                )
                    ?.FieldIdentifier
                    .Location ??
                    literal
                    .TypeIdentifier
                    .Location
            } else {
                syntax?.Location ?? default(TextLocation)
            }
            diagnostics.ReportCannotAssign(location, field.Name)
        }
    }

    internal func GetPrimaryArgument(name string) BoundFieldInitializer? {
        let member = GetPrimaryMember(StructType, name)
        for initializer in Initializers {
            if (initializer.Property != nil && initializer.Property == member) ||
                (initializer.Field != nil && initializer.Field == member) {
                return initializer
            }
        }
        return nil
    }

    internal func GetPrimaryConstructorArguments() ImmutableArray[
        (Field FieldSymbol, Value BoundExpression, IsSupplied bool)
    ] {
        // Imported positional literals already carry their CLR constructor's
        // property arguments; they do not have compiler-owned storage fields.
        if StructType.ClrType != nil {
            return ImmutableArray[(Field FieldSymbol, Value BoundExpression, IsSupplied bool)].Empty
        }
        let arguments = ImmutableArray.CreateBuilder[(Field FieldSymbol, Value BoundExpression, IsSupplied bool)](
            StructType.PrimaryConstructorParameters.Length
        )
        for parameter in StructType.PrimaryConstructorParameters {
            ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(StructType, parameter.Name, out var field)
            if field == nil {
                continue
            }
            let storage = field
            let initializer BoundFieldInitializer? = Initializers.FirstOrDefault(
                (candidate BoundFieldInitializer) -> candidate.Field == storage ||
                    candidate
                    .Property
                    ?.BackingField == storage
            )
            arguments.Add(
                (storage, initializer?.Value ?? BoundDefaultExpression(Syntax, storage.Type), initializer != nil)
            )
        }
        return arguments.ToImmutable()
    }

    shared {
        internal func CanWriteInitializerField(type StructSymbol, field FieldSymbol) bool -> !field.IsReadOnly ||
            type.ClrType == nil

        internal func PreparePrimaryArguments(
            syntax SyntaxNode?,
            type StructSymbol,
            initializers ImmutableArray[BoundFieldInitializer]
        ) ImmutableArray[BoundFieldInitializer] {
            var builder ImmutableArray[BoundFieldInitializer].Builder? = nil
            for parameter in type.PrimaryConstructorParameters {
                let member = Invariant.Required(
                    GetPrimaryMember(type, parameter.Name),
                    "a primary argument has an own field or property",
                    expression: "GetPrimaryMember(type, parameter.Name)"
                )
                if initializers.Any(
                    (initializer BoundFieldInitializer) -> initializer.Field == member || initializer.Property == member
                ) {
                    continue
                }
                // Defaults are children of the bound literal, so rewriting and
                // slot planning see exactly the nodes that emission will consume.
                let value = MagicCollectionZeroValue.TrySynthesizeEmptyInstance(syntax, parameter.Type) ??
                    BoundDefaultExpression(syntax, parameter.Type)
                builder ??= initializers.ToBuilder()
                builder!!.Add(
                    if member is FieldSymbol field {
                        BoundFieldInitializer(field, value)
                    } else {
                        BoundFieldInitializer(
                            Invariant.Required(
                                member as PropertySymbol,
                                "a primary member is a field or property",
                                expression: "member as PropertySymbol"
                            ),
                            value
                        )
                    }
                )
            }
            return builder?.ToImmutable() ?? initializers
        }

        internal func GetPrimaryMember(type StructSymbol, name string) Symbol? {
            for parameter in type.PrimaryConstructorParameters {
                if parameter.Name == name {
                    return TypeMemberModel.LookupMember(
                        type,
                        name,
                        MemberQuery(
                            includeInstance: true,
                            includeStatic: false,
                            includeInherited: false,
                            MemberKinds.Property | MemberKinds.Field
                        )
                    )
                }
            }
            return nil
        }

        internal func IsStagedConstruction(block BoundBlockExpression) bool {
            if block.Statements.IsDefaultOrEmpty || !(block.Expression is BoundStructLiteralExpression) {
                return false
            }
            for statement in block.Statements {
                if !(statement is BoundVariableDeclaration && statement.Initializer != nil) {
                    return false
                }
            }
            return true
        }
    }
}
