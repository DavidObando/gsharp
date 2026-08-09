// <copyright file="StructValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Boxed representation of a user-defined struct value (Phase 3.B.1),
/// historically the tree-walking evaluator's carrier for Go-style value
/// semantics (assignment and field writes went through copies). The
/// evaluator retired in ADR-0156 Phase 3c; the class survives because the
/// binder's explicit-layout analysis reuses its storage-size computation
/// (<see cref="TryGetStorageSize"/>, see <c>StructLayoutBinder</c>).
/// </summary>
public sealed class StructValue
{
    private readonly LayoutRuntime? explicitLayout;
    private readonly object? explicitLayoutValue;

    /// <summary>Initializes a new instance of the <see cref="StructValue"/> class.</summary>
    /// <param name="structType">The struct type symbol.</param>
    public StructValue(StructSymbol structType)
    {
        StructType = structType;
        Fields = new FieldCollection(this);

        if (structType.LayoutMetadata?.Layout == LayoutKind.Explicit)
        {
            explicitLayout = LayoutRuntime.Get(structType);
            explicitLayoutValue = explicitLayout.CreateDefault();
            explicitLayout.ReadFields(explicitLayoutValue, Fields);
        }
    }

    private StructValue(
        StructSymbol structType,
        ConcurrentDictionary<string, object?> fields,
        LayoutRuntime? explicitLayout = null,
        object? explicitLayoutValue = null)
    {
        StructType = structType;
        Fields = new FieldCollection(this);
        foreach (var field in fields)
        {
            Fields.SetRaw(field.Key, field.Value);
        }

        this.explicitLayout = explicitLayout;
        this.explicitLayoutValue = explicitLayoutValue;
    }

    /// <summary>Gets the struct type.</summary>
    public StructSymbol StructType { get; }

    // Issue #1718 (historical): under the evaluator, class-typed StructValue
    // instances were shared by reference across goroutines, so this storage
    // uses a ConcurrentDictionary rather than a plain Dictionary. The
    // concurrent shape is retained for the surviving explicit-layout uses.

    /// <summary>Gets the mutable field storage backing this instance.</summary>
    public FieldCollection Fields { get; }

    /// <inheritdoc/>
    public override bool Equals(object? obj)
    {
        if (StructType.IsClass && !StructType.IsData)
        {
            return ReferenceEquals(this, obj);
        }

        if (obj is not StructValue other)
        {
            return false;
        }

        if (StructType != other.StructType)
        {
            return false;
        }

        foreach (var (_, storageKey) in GetDisplayMembers(StructType))
        {
            Fields.TryGetValue(storageKey, out var lv);
            other.Fields.TryGetValue(storageKey, out var rv);
            if (!object.Equals(lv, rv))
            {
                return false;
            }
        }

        return true;
    }

    /// <inheritdoc/>
    public override int GetHashCode()
    {
        if (StructType.IsClass && !StructType.IsData)
        {
            return RuntimeHelpers.GetHashCode(this);
        }

        var hash = default(HashCode);
        hash.Add(StructType);
        foreach (var (_, storageKey) in GetDisplayMembers(StructType))
        {
            Fields.TryGetValue(storageKey, out var v);
            hash.Add(v);
        }

        return hash.ToHashCode();
    }

    /// <inheritdoc/>
    public override string ToString()
    {
        var sb = new StringBuilder();
        sb.Append(StructType.Name).Append('(');
        var first = true;
        foreach (var (displayName, storageKey) in GetDisplayMembers(StructType))
        {
            if (!first)
            {
                sb.Append(", ");
            }

            first = false;
            Fields.TryGetValue(storageKey, out var v);
            sb.Append(displayName).Append('=');
            sb.Append(v is null ? "nil" : System.Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        sb.Append(')');
        return sb.ToString();
    }

    internal static bool TryGetStorageSize(StructSymbol structType, out int size)
    {
        size = 0;
        try
        {
            size = LayoutRuntime.Get(structType).Size;
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (TargetInvocationException)
        {
            return false;
        }
        catch (TypeLoadException)
        {
            return false;
        }
    }

    private void SetField(string name, object? value)
    {
        if (explicitLayout != null)
        {
            // explicitLayoutValue is assigned by the same constructor branch
            // that sets explicitLayout, tested non-null just above.
            lock (explicitLayoutValue!)
            {
                if (explicitLayout.TrySetField(explicitLayoutValue, name, value))
                {
                    explicitLayout.ReadFields(explicitLayoutValue, Fields);
                    return;
                }
            }
        }

        Fields.SetRaw(name, value);
    }

    // Rubber-duck follow-up to issue #2224: an anonymous-class literal's
    // synthesized type exposes get-only auto-properties, not plain fields
    // (see AnonymousTypeCache); its runtime storage in Fields lives under
    // the property's backing-field name. Ordinary structs/classes keep
    // Fields non-empty and are unaffected.
    private static System.Collections.Generic.IEnumerable<(string DisplayName, string StorageKey)> GetDisplayMembers(StructSymbol type)
    {
        if (!type.Fields.IsDefaultOrEmpty)
        {
            foreach (var field in type.Fields)
            {
                yield return (field.Name, field.Name);
            }

            yield break;
        }

        foreach (var property in type.Properties)
        {
            if (property.IsAutoProperty && property.BackingField != null)
            {
                yield return (property.Name, property.BackingField.Name);
            }
        }
    }

    /// <summary>
    /// Field storage that routes indexer writes through the owning value so
    /// explicit-layout aliases stay synchronized.
    /// </summary>
    public sealed class FieldCollection : IEnumerable<KeyValuePair<string, object?>>
    {
        private readonly ConcurrentDictionary<string, object?> fields = new();
        private readonly StructValue owner;

        internal FieldCollection(StructValue owner)
        {
            this.owner = owner;
        }

        /// <summary>Gets or sets a field value.</summary>
        /// <param name="key">Field name.</param>
        /// <returns>Stored field value.</returns>
        public object? this[string key]
        {
            get => fields[key];
            set => owner.SetField(key, value);
        }

        /// <summary>Tests whether storage contains a field name.</summary>
        /// <param name="key">Field name.</param>
        /// <returns><see langword="true"/> when the field exists.</returns>
        public bool ContainsKey(string key) => fields.ContainsKey(key);

        /// <summary>Gets a field value when present.</summary>
        /// <param name="key">Field name.</param>
        /// <param name="value">Stored value when found.</param>
        /// <returns><see langword="true"/> when the field exists.</returns>
        public bool TryGetValue(string key, out object? value) => fields.TryGetValue(key, out value);

        /// <summary>Enumerates stored fields.</summary>
        /// <returns>Field enumerator.</returns>
        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => fields.GetEnumerator();

        /// <inheritdoc/>
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();

        internal void SetRaw(string key, object? value) => fields[key] = value;
    }

    private sealed class LayoutRuntime
    {
        private static readonly object Gate = new();
        private static readonly Dictionary<StructSymbol, LayoutRuntime> Cache = [];
        private static readonly ModuleBuilder Module = AssemblyBuilder
            .DefineDynamicAssembly(new AssemblyName("GSharp.Interpreter.Layouts"), AssemblyBuilderAccess.Run)
            .DefineDynamicModule("Layouts");

        private static readonly MethodInfo? ManagedSizeOfMethod = typeof(LayoutRuntime).GetMethod(
            nameof(ManagedSizeOf),
            BindingFlags.Static | BindingFlags.NonPublic);

        private static int nextId;

        private readonly StructSymbol symbol;
        private readonly Dictionary<string, FieldInfo> fields;

        private LayoutRuntime(StructSymbol symbol, Type type, Dictionary<string, FieldInfo> fields, int size)
        {
            this.symbol = symbol;
            Type = type;
            this.fields = fields;
            Size = size;
        }

        public Type Type { get; }

        public int Size { get; }

        public static LayoutRuntime Get(StructSymbol symbol)
        {
            lock (Gate)
            {
                if (Cache.TryGetValue(symbol, out var runtime))
                {
                    return runtime;
                }

                runtime = Create(symbol);
                Cache[symbol] = runtime;
                return runtime;
            }
        }

        public object? CreateDefault() => Activator.CreateInstance(Type);

        public bool TrySetField(object? target, string name, object? value)
        {
            if (!fields.TryGetValue(name, out var runtimeField))
            {
                return false;
            }

            var field = symbol.Fields.First(f => f.Name == name);
            runtimeField.SetValue(target, ToRuntimeValue(field.Type, value));
            return true;
        }

        public void ReadFields(object? source, FieldCollection destination)
        {
            foreach (var field in symbol.Fields)
            {
                if (fields.TryGetValue(field.Name, out var runtimeField))
                {
                    destination.SetRaw(
                        field.Name,
                        ToInterpreterValue(field.Type, runtimeField.GetValue(source)));
                }
            }
        }

        public void ReadFields(object? source, ConcurrentDictionary<string, object?> destination)
        {
            foreach (var field in symbol.Fields)
            {
                if (fields.TryGetValue(field.Name, out var runtimeField))
                {
                    destination[field.Name] = ToInterpreterValue(field.Type, runtimeField.GetValue(source));
                }
            }
        }

        private object? CreateValue(StructValue value)
        {
            if (value.explicitLayout == this)
            {
                return RuntimeHelpers.GetObjectValue(value.explicitLayoutValue);
            }

            var result = CreateDefault();
            foreach (var field in symbol.Fields)
            {
                if (fields.TryGetValue(field.Name, out var runtimeField)
                    && value.Fields.TryGetValue(field.Name, out var fieldValue))
                {
                    runtimeField.SetValue(result, ToRuntimeValue(field.Type, fieldValue));
                }
            }

            return result;
        }

        private static LayoutRuntime Create(StructSymbol symbol)
        {
            var metadata = symbol.LayoutMetadata;
            var attributes = TypeAttributes.Public
                | TypeAttributes.Sealed
                | TypeAttributes.BeforeFieldInit
                | (metadata?.Layout == LayoutKind.Explicit
                    ? TypeAttributes.ExplicitLayout
                    : TypeAttributes.SequentialLayout);
            var builder = Module.DefineType(
                $"GSharpLayout_{Interlocked.Increment(ref nextId)}",
                attributes,
                symbol.IsClass ? typeof(object) : typeof(ValueType),
                ToPackingSize(metadata?.Pack),
                metadata?.Size ?? 0);

            foreach (var field in symbol.Fields)
            {
                if (field.IsStatic || field.IsConst)
                {
                    continue;
                }

                var runtimeField = builder.DefineField(
                    field.Name,
                    ResolveRuntimeType(field.Type),
                    FieldAttributes.Public);
                if (field.ExplicitOffset is int offset)
                {
                    runtimeField.SetOffset(offset);
                }
            }

            var type = builder.CreateType();
            var fields = new Dictionary<string, FieldInfo>(StringComparer.Ordinal);
            foreach (var field in symbol.Fields)
            {
                var runtimeField = type.GetField(field.Name, BindingFlags.Public | BindingFlags.Instance);
                if (runtimeField != null)
                {
                    fields[field.Name] = runtimeField;
                }
            }

            // The method is a private static on LayoutRuntime and returns an int.
            var size = (int)ManagedSizeOfMethod!.MakeGenericMethod(type).Invoke(null, null)!;
            return new LayoutRuntime(symbol, type, fields, size);
        }

        private static int ManagedSizeOf<T>() => Unsafe.SizeOf<T>();

        private static Type ResolveRuntimeType(TypeSymbol type)
        {
            if (type is StructSymbol nested)
            {
                return nested.IsClass ? typeof(object) : Get(nested).Type;
            }

            if (type is EnumSymbol enumType)
            {
                return enumType.ClrType
                    ?? Invariant.Required(enumType.UnderlyingType.ClrType, "an enum has a CLR underlying type");
            }

            return NullableTypeSymbol.GetEffectiveClrType(type) ?? typeof(object);
        }

        private static object? ToRuntimeValue(TypeSymbol type, object? value)
        {
            if (type is StructSymbol nested
                && !nested.IsClass
                && value is StructValue structValue)
            {
                return Get(nested).CreateValue(structValue);
            }

            if (type is EnumSymbol enumType && enumType.ClrType != null && value != null)
            {
                return Enum.ToObject(enumType.ClrType, value);
            }

            return value;
        }

        private static object? ToInterpreterValue(TypeSymbol type, object? value)
        {
            if (type is StructSymbol nested
                && !nested.IsClass
                && value != null)
            {
                var runtime = Get(nested);
                var fields = new ConcurrentDictionary<string, object?>();
                runtime.ReadFields(value, fields);
                var keepBacking = nested.LayoutMetadata?.Layout == LayoutKind.Explicit;
                return new StructValue(
                    nested,
                    fields,
                    keepBacking ? runtime : null,
                    keepBacking ? RuntimeHelpers.GetObjectValue(value) : null);
            }

            if (type is EnumSymbol enumType && enumType.ClrType != null && value != null)
            {
                return Convert.ChangeType(
                    value,
                    Invariant.Required(enumType.UnderlyingType.ClrType, "an enum has a CLR underlying type"),
                    CultureInfo.InvariantCulture);
            }

            return value;
        }

        private static PackingSize ToPackingSize(int? pack) =>
            pack switch
            {
                1 => PackingSize.Size1,
                2 => PackingSize.Size2,
                4 => PackingSize.Size4,
                8 => PackingSize.Size8,
                16 => PackingSize.Size16,
                32 => PackingSize.Size32,
                64 => PackingSize.Size64,
                128 => PackingSize.Size128,
                _ => PackingSize.Unspecified,
            };
    }
}
