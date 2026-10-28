// <copyright file="FieldSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Reflection

/// Represents a field declared on a user-defined struct (Phase 3.B.1).
class FieldSymbol : Symbol {
    /// Initializes a new instance of the (cref:FieldSymbol) class.
    /// @param name The field name.
    /// @param type The field type.
    /// @param accessibility The field accessibility.
    /// @param isReadOnly True when the field is init-only after construction.
    /// @param isStatic True when the field is declared inside a `shared` block (ADR-0053).
    /// @param isConst True when the field is a compile-time constant declared with `const` (Issue #948).
    /// Const fields are implicitly static and read-only and emitted as literal fields.
    /// @param isEventBackingField True when this field is the compiler-synthesized backing field of a
    /// field-like `event` declaration (issue #2083). Unlike an ordinary non-nullable field/local/parameter,
    /// an event backing field's declared (non-nullable) delegate type does not guarantee a non-null runtime
    /// value: an unsubscribed event's backing field genuinely holds `null`. The emitter uses this flag to
    /// keep the null-guarded delegate-to-delegate adaptation (issue #2066) for event snapshots while
    /// restoring the fail-fast (throwing) adaptation for every other statically non-nullable source.
    /// @param declaration The declaring field or primary-constructor parameter syntax, or `null` for
    /// imported and synthesized fields.
    init(
        name string,
        type TypeSymbol,
        accessibility Accessibility,
        isReadOnly bool = false,
        isStatic bool = false,
        isConst bool = false,
        isEventBackingField bool = false,
        declaration SyntaxNode? = nil
    ) : base(name) {
        Type = type
        Accessibility = accessibility
        IsReadOnly = isReadOnly
        IsStatic = isStatic
        IsConst = isConst
        IsEventBackingField = isEventBackingField
        Declaration = declaration
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    /// Gets the reflected member an imported symbol stands for, or null for a declared one (ADR-0212 slice S4).
    /// @remarks The language server reads it to find documentation and cross-assembly definitions until
    /// handle-backed imported symbols replace it (ADR-0209 stage 6).
    prop ImportedMember FieldInfo? {
        get;
        internal set;
    }

    override prop Kind SymbolKind -> SymbolKind.Field

    /// Gets the declaring field or primary-constructor parameter syntax, or `null` for imported and
    /// synthesized fields.
    prop Declaration SyntaxNode? {
        get;
        private set;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> switch Declaration {
        case fieldDeclaration is FieldDeclarationSyntax: ImmutableArray.Create[SyntaxNode](fieldDeclaration.Identifier)
        case parameter is ParameterSyntax: ImmutableArray.Create[SyntaxNode](parameter.Identifier!!)
        default: ImmutableArray[SyntaxNode].Empty
    }

    /// Gets the field type.
    prop Type TypeSymbol {
        get;
        private set;
    }

    /// Gets the field accessibility.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets a value indicating whether this field is init-only after construction.
    prop IsReadOnly bool {
        get;
    }

    /// Gets a value indicating whether this field is declared inside a `shared` block (ADR-0053).
    prop IsStatic bool {
        get;
    }

    /// Gets a value indicating whether this field is a compile-time constant
    /// declared with `const` (Issue #948). A const field is implicitly
    /// static and read-only, and its reads inline (cref:ConstantValue).
    /// ECMA constants emit as literal fields; decimal uses initialized static
    /// read-only storage with `DecimalConstantAttribute`.
    prop IsConst bool {
        get;
    }

    /// Gets a value indicating whether this field is the compiler-synthesized
    /// backing field of a field-like `event` (issue #2083). See the
    /// constructor parameter of the same name for why this distinction
    /// matters to the emitter's delegate-to-delegate null-guard.
    prop IsEventBackingField bool {
        get;
    }

    /// Gets the compile-time constant value for a (cref:IsConst) field
    /// (Issue #948), or `null` for non-const fields. The binder folds the
    /// field initializer to a literal and writes it here; the emitter uses it
    /// to add the `Constant` metadata row and to inline const-field reads.
    prop ConstantValue object? {
        get;
        private set;
    }

    /// Gets the explicit byte offset declared via `@FieldOffset(N)`
    /// (ADR-0093 / issue #759), or `null` when the field uses the
    /// default sequential layout. Only valid on fields of types declared
    /// with `@StructLayout(LayoutKind.Explicit)`; the binder enforces
    /// the mutual constraint (GS0347 / GS0348) and writes the resolved
    /// offset onto the symbol so the emitter can produce a matching
    /// `FieldLayout` row.
    prop ExplicitOffset int32? {
        get;
        private set;
    }

    /// Gets a value indicating whether this field is a fixed-size buffer
    /// (ADR-0122 §10 / issue #1035, spelled `fixed name [N]T`). When
    /// true, (cref:Type) is the compiler-generated nested buffer struct
    /// (carrying the `[FixedBuffer]` attribute and explicit layout size),
    /// and references to the field decay to a `*T` to the first element.
    prop IsFixedBuffer bool {
        get;
        private set;
    }

    /// Gets the fixed-size buffer element type `T` (ADR-0122 §10 / issue #1035), or `null` for non-buffer
    /// fields.
    prop FixedBufferElementType TypeSymbol? {
        get;
        private set;
    }

    /// Gets the fixed-size buffer element count `N` (ADR-0122 §10 / issue #1035), or 0 for non-buffer
    /// fields.
    prop FixedBufferLength int32 {
        get;
        private set;
    }

    /// Sets the (cref:ConstantValue) for a const field. Intended to be
    /// called once by the binder after folding the initializer to a literal.
    /// @param value The compile-time constant value.
    func SetConstantValue(value object?) {
        ConstantValue = value
    }

    /// Sets the resolved (cref:ExplicitOffset). Intended to be
    /// called once by the binder after attribute binding when the field
    /// carries a well-formed `@FieldOffset(N)` annotation.
    /// @param offset The non-negative byte offset.
    func SetExplicitOffset(offset int32) {
        ExplicitOffset = offset
    }

    /// Marks this field as a fixed-size buffer (ADR-0122 §10 / issue #1035),
    /// recording the element type and count.
    /// @param elementType The buffer element type `T`.
    /// @param length The buffer element count `N`.
    func SetFixedBuffer(elementType TypeSymbol, length int32) {
        IsFixedBuffer = true
        FixedBufferElementType = elementType
        FixedBufferLength = length
    }

    /// Re-points this reused field symbol at the corresponding declaration in a freshly parsed syntax tree.
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration SyntaxNode) {
        Declaration = declaration
    }

    /// Replaces the placeholder type of a predeclared rich-anonymous field
    /// after its literal-site initializer has been bound.
    /// @param type The inferred or explicitly declared field type.
    internal func SetRichAnonymousType(type TypeSymbol) {
        Type = type
    }

    /// Returns whether this static field may be addressed in the current
    /// static-constructor context.
    /// @param staticConstructorOwner The type whose `.cctor` is active, or `null`.
    /// @returns `true` when taking the field address is legal.
    internal func IsStaticAddressLegal(staticConstructorOwner Symbol?) bool {
        if !(IsReadOnly && IsStatic) || IsConst {
            return true
        }
        return switch staticConstructorOwner {
            case s is StructSymbol: !s.StaticFields.IsDefaultOrEmpty && s.StaticFields.Contains(this)
            case i is InterfaceSymbol: !i.StaticFields.IsDefaultOrEmpty && i.StaticFields.Contains(this)
            default: false
        }
    }
}
