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
import System.Collections.Generic
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

    convenience init(
        syntax SyntaxNode?,
        structType StructSymbol,
        initializers ImmutableArray[BoundFieldInitializer],
        copySource BoundExpression?,
        isZeroInitialization bool
    ) {
        init(syntax, structType, initializers, copySource, isZeroInitialization, nil)
    }

    internal init(
        syntax SyntaxNode?,
        structType StructSymbol,
        initializers ImmutableArray[BoundFieldInitializer],
        copySource BoundExpression?,
        isZeroInitialization bool,
        resultType TypeSymbol?
    ) : base(syntax) {
        if copySource != nil && (!structType.IsData || !initializers.IsEmpty) {
            throw ArgumentException("A copy literal must be a data type without member initializers.", "copySource")
        }
        StructType = structType
        CopySource = copySource
        IsZeroInitialization = isZeroInitialization
        ResultType = resultType
        let explicitInitializers = if CallsDataConstructor || CallsPrimaryConstructor {
            initializers.Where((initializer BoundFieldInitializer) -> !initializer.IsDeclarationInitializer)
                .ToImmutableArray()
        } else {
            initializers
        }
        Initializers = if CallsPrimaryConstructor {
            PreparePrimaryArguments(syntax, structType, explicitInitializers)
        } else {
            explicitInitializers
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

    internal prop ResultType TypeSymbol? {
        get;
    }

    override prop Type TypeSymbol -> CopySource?.Type ?? ResultType ?? StructType
    override prop Kind BoundNodeKind -> BoundNodeKind.StructLiteralExpression

    internal prop CallsDataConstructor bool -> !IsZeroInitialization &&
        CopySource == nil &&
        StructType.UsesConstructorOwnedDataConstruction

    internal func IsInTypeZeroInitializer(initializer BoundFieldInitializer) bool -> IsZeroInitialization &&
        StructType.ClrType == nil &&
        (StructType.Definition ?? StructType).ValueStructDefaultCtorIsZeroInitialization &&
        (StructType.Definition ?? StructType).NeedsSynthesizedValueStructDefaultCtor &&
        initializer.Field is {} field &&
        MagicCollectionZeroValue.TrySynthesizeInTypeZeroField(Syntax, StructType, field) != nil

    internal prop CallsPrimaryConstructor bool -> !IsZeroInitialization &&
        CopySource == nil &&
        UsesPrimaryConstructor(StructType)

    /// Checks imported value-type stores after every construction path selects its initializers.
    internal func ValidateInitializerWrites(diagnostics DiagnosticBag, anchor SyntaxNode?) {
        // Class positional initializers may instead be arguments to an owning CLR constructor.
        if StructType.IsClass {
            return
        }
        for initializer in Initializers {
            if initializer.Field is not{} field ||
                CanWriteInitializerField(initializer.FieldDeclaringType ?? StructType, field) ||
                IsInTypeZeroInitializer(initializer) ||
                (CallsPrimaryConstructor && GetPrimaryMember(StructType, field.Name) == field) {
                continue
            }
            let syntax = anchor ?? Syntax
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
        internal func UsesPrimaryConstructor(type StructSymbol) bool -> if type.IsClass {
            type.ClrType == nil && (type.Definition ?? type).HasDeclaredPrimaryConstructor
        } else {
            type.HasDataConstructionPrimary
        }

        internal func CanWriteInitializerField(type StructSymbol, field FieldSymbol) bool ->
        !(type.ClrType != nil && field.Accessibility == Accessibility.Private) &&
            (!field.IsReadOnly || (type.ClrType == nil && (!type.IsData || type.IsClass)))

        internal func ValidateDataConstructor(
            type StructSymbol,
            diagnostics DiagnosticBag,
            syntax SyntaxNode?,
            currentFunction FunctionSymbol?,
            canAccessInternal bool,
            checkAccessibility bool = true,
            suppliedPrimaryInputs IEnumerable[string]? = nil
        ) bool {
            if !type.UsesConstructorOwnedDataConstruction && !UsesPrimaryConstructor(type) {
                return true
            }
            var valid = true
            if type.ClrType is {} imported {
                let constructor = type.GetDataConstructionConstructor()
                valid = if constructor != nil {
                    !checkAccessibility ||
                        constructor.IsPublic ||
                        (canAccessInternal && (constructor.IsAssembly || constructor.IsFamilyOrAssembly))
                } else {
                    !ImportedAssemblySemantics.TryGetTypeSemantics(imported, out _) &&
                        !type.HasDataConstructionPrimary &&
                        !ClrTypeUtilities
                        .SafeGetConstructors(
                        imported,
                        System.Reflection.BindingFlags.Instance |
                        System.Reflection.BindingFlags.Public |
                        System.Reflection.BindingFlags.NonPublic
                    )
                        .Any((candidate System.Reflection.ConstructorInfo) -> candidate.GetParameters().Length == 0)
                }
            } else if !UsesPrimaryConstructor(type) {
                let constructor = type.EffectiveExplicitConstructors.FirstOrDefault(
                    (candidate ConstructorSymbol) -> candidate.Parameters.IsEmpty
                )
                valid = !checkAccessibility || constructor == nil || AccessibilityChecker.IsAccessible(
                    constructor.Function.Accessibility,
                    type,
                    currentFunction
                )
            }
            if valid &&
                UsesPrimaryConstructor(type) &&
                (suppliedPrimaryInputs != nil || syntax is StructLiteralExpressionSyntax) {
                let suppliedNames = suppliedPrimaryInputs ??
                    (
                    cast[StructLiteralExpressionSyntax](syntax)
                        .Initializers
                        .Where(
                        (initializer FieldInitializerSyntax) ->
                        initializer.Value is not CollectionInitializerExpressionSyntax{Target: nil}
                    )
                        .Select((initializer FieldInitializerSyntax) -> initializer.FieldIdentifier.ValueText)
                )
                for parameter in type.PrimaryConstructorParameters {
                    if suppliedNames.Contains(parameter.Name) {
                        continue
                    }
                    let zero = MagicCollectionZeroValue.TrySynthesizePrimaryArgument(
                        syntax,
                        type,
                        parameter,
                        out var missingDeclarationShape
                    )
                    if missingDeclarationShape ||
                        parameter
                        .Type
                        .ReferenceNullability == ReferenceNullabilityKind.NotNull &&
                        parameter
                        .Type
                        .ClrType
                        ?.IsArray == true &&
                        zero == nil {
                        valid = false
                        break
                    }
                }
            }
            if !valid {
                let location = if syntax is StructLiteralExpressionSyntax literal {
                    literal.TypeIdentifier.Location
                } else {
                    syntax?.Location ?? default(TextLocation)
                }
                diagnostics.ReportNoApplicableOverload(location, type.Name)
            }
            return valid
        }

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
                let zero = MagicCollectionZeroValue.TrySynthesizePrimaryArgument(
                    syntax,
                    type,
                    parameter,
                    out var missingDeclarationShape
                )
                let value = if missingDeclarationShape {
                    BoundErrorExpression(syntax)
                } else {
                    zero ?? BoundDefaultExpression(syntax, parameter.Type)
                }
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
