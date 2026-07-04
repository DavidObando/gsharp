// <copyright file="FieldSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a field declared on a user-defined struct (Phase 3.B.1).
/// </summary>
public sealed class FieldSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldSymbol"/> class.
    /// </summary>
    /// <param name="name">The field name.</param>
    /// <param name="type">The field type.</param>
    /// <param name="accessibility">The field accessibility.</param>
    /// <param name="isReadOnly">True when the field is init-only after construction.</param>
    /// <param name="isStatic">True when the field is declared inside a <c>shared</c> block (ADR-0053).</param>
    /// <param name="isConst">True when the field is a compile-time constant declared with <c>const</c> (Issue #948). Const fields are implicitly static and read-only and emitted as literal fields.</param>
    /// <param name="isEventBackingField">True when this field is the compiler-synthesized backing field of a field-like <c>event</c> declaration (issue #2083). Unlike an ordinary non-nullable field/local/parameter, an event backing field's declared (non-nullable) delegate type does not guarantee a non-null runtime value: an unsubscribed event's backing field genuinely holds <c>null</c>. The emitter uses this flag to keep the null-guarded delegate-to-delegate adaptation (issue #2066) for event snapshots while restoring the fail-fast (throwing) adaptation for every other statically non-nullable source.</param>
    public FieldSymbol(string name, TypeSymbol type, Accessibility accessibility, bool isReadOnly = false, bool isStatic = false, bool isConst = false, bool isEventBackingField = false)
        : base(name)
    {
        Type = type;
        Accessibility = accessibility;
        IsReadOnly = isReadOnly;
        IsStatic = isStatic;
        IsConst = isConst;
        IsEventBackingField = isEventBackingField;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Field;

    /// <summary>Gets the field type.</summary>
    public TypeSymbol Type { get; }

    /// <summary>Gets the field accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets a value indicating whether this field is init-only after construction.</summary>
    public bool IsReadOnly { get; }

    /// <summary>Gets a value indicating whether this field is declared inside a <c>shared</c> block (ADR-0053).</summary>
    public bool IsStatic { get; }

    /// <summary>
    /// Gets a value indicating whether this field is a compile-time constant
    /// declared with <c>const</c> (Issue #948). A const field is implicitly
    /// static and read-only, is emitted as a CLR <c>literal</c> field carrying
    /// a <c>Constant</c> row, and its reads are inlined as the literal
    /// <see cref="ConstantValue"/> rather than a field load.
    /// </summary>
    public bool IsConst { get; }

    /// <summary>
    /// Gets a value indicating whether this field is the compiler-synthesized
    /// backing field of a field-like <c>event</c> (issue #2083). See the
    /// constructor parameter of the same name for why this distinction
    /// matters to the emitter's delegate-to-delegate null-guard.
    /// </summary>
    public bool IsEventBackingField { get; }

    /// <summary>
    /// Gets the compile-time constant value for a <see cref="IsConst"/> field
    /// (Issue #948), or <c>null</c> for non-const fields. The binder folds the
    /// field initializer to a literal and writes it here; the emitter uses it
    /// to add the <c>Constant</c> metadata row and to inline const-field reads.
    /// </summary>
    public object ConstantValue { get; private set; }

    /// <summary>
    /// Gets the explicit byte offset declared via <c>@FieldOffset(N)</c>
    /// (ADR-0093 / issue #759), or <c>null</c> when the field uses the
    /// default sequential layout. Only valid on fields of types declared
    /// with <c>@StructLayout(LayoutKind.Explicit)</c>; the binder enforces
    /// the mutual constraint (GS0347 / GS0348) and writes the resolved
    /// offset onto the symbol so the emitter can produce a matching
    /// <c>FieldLayout</c> row.
    /// </summary>
    public int? ExplicitOffset { get; private set; }

    /// <summary>
    /// Gets a value indicating whether this field is a fixed-size buffer
    /// (ADR-0122 §10 / issue #1035, spelled <c>fixed name [N]T</c>). When
    /// true, <see cref="Type"/> is the compiler-generated nested buffer struct
    /// (carrying the <c>[FixedBuffer]</c> attribute and explicit layout size),
    /// and references to the field decay to a <c>*T</c> to the first element.
    /// </summary>
    public bool IsFixedBuffer { get; private set; }

    /// <summary>Gets the fixed-size buffer element type <c>T</c> (ADR-0122 §10 / issue #1035), or <c>null</c> for non-buffer fields.</summary>
    public TypeSymbol FixedBufferElementType { get; private set; }

    /// <summary>Gets the fixed-size buffer element count <c>N</c> (ADR-0122 §10 / issue #1035), or 0 for non-buffer fields.</summary>
    public int FixedBufferLength { get; private set; }

    /// <summary>
    /// Sets the <see cref="ConstantValue"/> for a const field. Intended to be
    /// called once by the binder after folding the initializer to a literal.
    /// </summary>
    /// <param name="value">The compile-time constant value.</param>
    public void SetConstantValue(object value)
    {
        ConstantValue = value;
    }

    /// <summary>
    /// Sets the resolved <see cref="ExplicitOffset"/>. Intended to be
    /// called once by the binder after attribute binding when the field
    /// carries a well-formed <c>@FieldOffset(N)</c> annotation.
    /// </summary>
    /// <param name="offset">The non-negative byte offset.</param>
    public void SetExplicitOffset(int offset)
    {
        ExplicitOffset = offset;
    }

    /// <summary>
    /// Marks this field as a fixed-size buffer (ADR-0122 §10 / issue #1035),
    /// recording the element type and count.
    /// </summary>
    /// <param name="elementType">The buffer element type <c>T</c>.</param>
    /// <param name="length">The buffer element count <c>N</c>.</param>
    public void SetFixedBuffer(TypeSymbol elementType, int length)
    {
        IsFixedBuffer = true;
        FixedBufferElementType = elementType;
        FixedBufferLength = length;
    }
}
