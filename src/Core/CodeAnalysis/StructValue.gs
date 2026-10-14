// <copyright file="StructValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections
import System.Collections.Concurrent
import System.Collections.Generic
import System.Globalization
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Text
import System.Threading
import SystemObject = System.Object

/// Boxed representation of a user-defined struct value (Phase 3.B.1),
/// historically the tree-walking evaluator's carrier for Go-style value
/// semantics (assignment and field writes went through copies). The
/// evaluator retired in ADR-0156 Phase 3c; the class survives because the
/// binder's explicit-layout analysis reuses its storage-size computation
/// ((cref:TryGetStorageSize), see `StructLayoutBinder`).
class StructValue {
    private let explicitLayout LayoutRuntime?
    private let explicitLayoutValue object?

    /// Initializes a new instance of the (cref:StructValue) class.
    /// @param structType The struct type symbol.
    init(structType StructSymbol) {
        StructType = structType
        Fields = FieldCollection(this)
        if structType.LayoutMetadata?.Layout == LayoutKind.Explicit {
            explicitLayout = LayoutRuntime.Get(structType)
            explicitLayoutValue = explicitLayout!!.CreateDefault()
            explicitLayout!!.ReadFields(explicitLayoutValue, Fields)
        }
    }

    private init(
        structType StructSymbol,
        fields ConcurrentDictionary[string, object?],
        explicitLayout LayoutRuntime? = nil,
        explicitLayoutValue object? = nil
    ) {
        StructType = structType
        Fields = FieldCollection(this)
        for field in fields {
            Fields.SetRaw(field.Key, field.Value)
        }
        this.explicitLayout = explicitLayout
        this.explicitLayoutValue = explicitLayoutValue
    }

    /// Gets the struct type.
    prop StructType StructSymbol {
        get;
    }

    // Issue #1718 (historical): under the evaluator, class-typed StructValue
    // instances were shared by reference across goroutines, so this storage
    // uses a ConcurrentDictionary rather than a plain Dictionary. The
    // concurrent shape is retained for the surviving explicit-layout uses.
    /// Gets the mutable field storage backing this instance.
    prop Fields FieldCollection {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Equals(obj object?) bool {
        if StructType.IsClass && !StructType.IsData {
            return object.ReferenceEquals(this, obj)
        }
        if obj is not StructValue other {
            return false
        }
        if StructType != other.StructType {
            return false
        }
        for (_, storageKey) in GetDisplayMembers(StructType) {
            Fields.TryGetValue(storageKey, out var lv)
            other.Fields.TryGetValue(storageKey, out var rv)
            if !object.Equals(lv, rv) {
                return false
            }
        }
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetHashCode() int32 {
        if StructType.IsClass && !StructType.IsData {
            return RuntimeHelpers.GetHashCode(this)
        }
        var hash = default(HashCode)
        hash.Add(StructType)
        for (_, storageKey) in GetDisplayMembers(StructType) {
            Fields.TryGetValue(storageKey, out var v)
            hash.Add(v)
        }
        return hash.ToHashCode()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func ToString() string {
        let sb = StringBuilder()
        sb.Append(StructType.Name).Append('(')
        var first = true
        for (displayName, storageKey) in GetDisplayMembers(StructType) {
            if !first {
                sb.Append(", ")
            }
            first = false
            Fields.TryGetValue(storageKey, out var v)
            sb.Append(displayName).Append('=')
            sb.Append(
                if v == nil {
                    "nil"
                } else {
                    Convert.ToString(v, CultureInfo.InvariantCulture)
                }
            )
        }
        sb.Append(')')
        return sb.ToString()
    }

    private func SetField(name string, value object?) {
        if explicitLayout != nil {
            // explicitLayoutValue is assigned by the same constructor branch
            // that sets explicitLayout, tested non-null just above.
            lock explicitLayoutValue!! {
                if explicitLayout!!.TrySetField(explicitLayoutValue, name, value) {
                    explicitLayout!!.ReadFields(explicitLayoutValue, Fields)
                    return
                }
            }
        }
        Fields.SetRaw(name, value)
    }

    /// Field storage that routes indexer writes through the owning value so
    /// explicit-layout aliases stay synchronized.
    class FieldCollection : IEnumerable[KeyValuePair[string, object?]] {
        private let fields ConcurrentDictionary[string, object?] = ConcurrentDictionary[string, object?]()
        private let owner StructValue

        internal init(owner StructValue) {
            this.owner = owner
        }

        /// Gets or sets a field value.
        /// @param key Field name.
        /// @returns Stored field value.
        prop this[key string]object? {
            get -> fields[key]
            set -> owner.SetField(key, value)
        }

        /// Tests whether storage contains a field name.
        /// @param key Field name.
        /// @returns `true` when the field exists.
        func ContainsKey(key string) bool -> fields.ContainsKey(key)

        /// Gets a field value when present.
        /// @param key Field name.
        /// @param value Stored value when found.
        /// @returns `true` when the field exists.
        func TryGetValue(key string, out value object?) bool -> fields.TryGetValue(key, out value)

        /// Enumerates stored fields.
        /// @returns Field enumerator.
        func GetEnumerator() IEnumerator[KeyValuePair[string, object?]] -> fields.GetEnumerator()

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

        internal func SetRaw(key string, value object?) -> fields[key] = value
    }

    private class LayoutRuntime {
        private let symbol StructSymbol
        private let fields Dictionary[string, FieldInfo]

        private init(symbol StructSymbol, type Type, fields Dictionary[string, FieldInfo], size int32) {
            this.symbol = symbol
            Type = type
            this.fields = fields
            Size = size
        }

        prop Type Type {
            get;
        }

        prop Size int32 {
            get;
        }

        func CreateDefault() object? -> Activator.CreateInstance(Type)

        func TrySetField(target object?, name string, value object?) bool {
            if !fields.TryGetValue(name, out var runtimeField) {
                return false
            }
            let field = symbol.Fields.First((f FieldSymbol) -> f.Name == name)
            runtimeField.SetValue(target, ToRuntimeValue(field.Type, value))
            return true
        }

        func ReadFields(source object?, destination FieldCollection) {
            for field in symbol.Fields {
                if fields.TryGetValue(field.Name, out var runtimeField) {
                    destination.SetRaw(field.Name, ToInterpreterValue(field.Type, runtimeField.GetValue(source)))
                }
            }
        }

        func ReadFields(source object?, destination ConcurrentDictionary[string, object?]) {
            for field in symbol.Fields {
                if fields.TryGetValue(field.Name, out var runtimeField) {
                    destination[field.Name] = ToInterpreterValue(field.Type, runtimeField.GetValue(source))
                }
            }
        }

        private func CreateValue(value StructValue) object? {
            if value.explicitLayout == this {
                return RuntimeHelpers.GetObjectValue(value.explicitLayoutValue)
            }
            let result = CreateDefault()
            for field in symbol.Fields {
                if fields.TryGetValue(field.Name, out var runtimeField) && value.Fields.TryGetValue(
                    field.Name,
                    out var fieldValue
                ) {
                    runtimeField.SetValue(result, ToRuntimeValue(field.Type, fieldValue))
                }
            }
            return result
        }

        shared {
            private let Gate object = SystemObject()
            private let Cache Dictionary[StructSymbol, LayoutRuntime] = Dictionary[StructSymbol, LayoutRuntime]()
            private let Module ModuleBuilder = AssemblyBuilder.DefineDynamicAssembly(
                AssemblyName("GSharp.Interpreter.Layouts"),
                AssemblyBuilderAccess.Run
            )
                .DefineDynamicModule("Layouts")
            private let ManagedSizeOfMethod MethodInfo? = typeof(LayoutRuntime).GetMethod(
                "ManagedSizeOf",
                BindingFlags.Static | BindingFlags.NonPublic
            )
            private var nextId int32

            func Get(symbol StructSymbol) LayoutRuntime {
                lock Gate {
                    if Cache.TryGetValue(symbol, out var runtime) {
                        return runtime
                    }
                    runtime = Create(symbol)
                    Cache[symbol] = runtime
                    return runtime
                }
            }

            private func Create(symbol StructSymbol) LayoutRuntime {
                let metadata = symbol.LayoutMetadata
                let attributes = TypeAttributes.Public | TypeAttributes.Sealed | TypeAttributes.BeforeFieldInit | (
                    if metadata?.Layout == LayoutKind.Explicit {
                        TypeAttributes.ExplicitLayout
                    } else {
                        TypeAttributes.SequentialLayout
                    }
                )
                let builder = LayoutRuntime.Module.DefineType(
                    "GSharpLayout_${Interlocked.Increment(&nextId)}",
                    attributes,
                    if symbol.IsClass {
                        typeof(object)
                    } else {
                        typeof(ValueType)
                    },
                    ToPackingSize(metadata?.Pack),
                    metadata?.Size ?? 0
                )
                for field in symbol.Fields {
                    if field.IsStatic || field.IsConst {
                        continue
                    }
                    let runtimeField = builder.DefineField(
                        field.Name,
                        ResolveRuntimeType(field.Type),
                        FieldAttributes.Public
                    )
                    if field.ExplicitOffset is int32 offset {
                        runtimeField.SetOffset(offset)
                    }
                }
                let type = builder.CreateType()
                let fields = Dictionary[string, FieldInfo](StringComparer.Ordinal)
                for field in symbol.Fields {
                    let runtimeField FieldInfo? = type.GetField(field.Name, BindingFlags.Public | BindingFlags.Instance)
                    if runtimeField != nil {
                        fields[field.Name] = runtimeField
                    }
                }
                // The method is a private static on LayoutRuntime and returns an int.
                let size = int32(ManagedSizeOfMethod!!.MakeGenericMethod(type).Invoke(nil, nil)!!)
                return LayoutRuntime(symbol, type, fields, size)
            }

            private func ManagedSizeOf[T]() int32 -> Unsafe.SizeOf[T]()

            private func ResolveRuntimeType(type TypeSymbol) Type {
                if type is StructSymbol nested {
                    return if nested.IsClass {
                        typeof(object)
                    } else {
                        Get(nested).Type
                    }
                }
                if type is EnumSymbol enumType {
                    return enumType.ClrType ?? Invariant.Required(
                        enumType.UnderlyingType.ClrType,
                        "an enum has a CLR underlying type",
                        expression: "enumType.UnderlyingType.ClrType"
                    )
                }
                return NullableTypeSymbol.GetEffectiveClrType(type) ?? typeof(object)
            }

            private func ToRuntimeValue(type TypeSymbol, value object?) object? {
                if type is StructSymbol nested && !nested.IsClass && value is StructValue structValue {
                    return Get(nested).CreateValue(structValue)
                }
                if type is EnumSymbol enumType && enumType.ClrType != nil && value != nil {
                    return Enum.ToObject(enumType.ClrType, value)
                }
                return value
            }

            private func ToInterpreterValue(type TypeSymbol, value object?) object? {
                if type is StructSymbol nested && !nested.IsClass && value != nil {
                    let runtime = Get(nested)
                    let fields = ConcurrentDictionary[string, object?]()
                    runtime.ReadFields(value, fields)
                    let keepBacking = nested.LayoutMetadata?.Layout == LayoutKind.Explicit
                    return StructValue(
                        nested,
                        fields,
                        if keepBacking {
                            runtime
                        } else {
                            default(LayoutRuntime?)
                        },
                        if keepBacking {
                            RuntimeHelpers.GetObjectValue(value)
                        } else {
                            default(object?)
                        }
                    )
                }
                if type is EnumSymbol enumType && enumType.ClrType != nil && value != nil {
                    return Convert.ChangeType(
                        value,
                        Invariant.Required(
                            enumType.UnderlyingType.ClrType,
                            "an enum has a CLR underlying type",
                            expression: "enumType.UnderlyingType.ClrType"
                        ),
                        CultureInfo.InvariantCulture
                    )
                }
                return value
            }

            private func ToPackingSize(pack int32?) PackingSize -> switch pack {
                case 1: PackingSize.Size1
                case 2: PackingSize.Size2
                case 4: PackingSize.Size4
                case 8: PackingSize.Size8
                case 16: PackingSize.Size16
                case 32: PackingSize.Size32
                case 64: PackingSize.Size64
                case 128: PackingSize.Size128
                default: PackingSize.Unspecified
            }
        }
    }

    shared {
        internal func TryGetStorageSize(structType StructSymbol, out size int32) bool {
            size = 0
            try {
                size = LayoutRuntime.Get(structType).Size
                return true
            } catch (ArgumentException) {
                return false
            } catch (TargetInvocationException) {
                return false
            } catch (TypeLoadException) {
                return false
            }
        }

        // Rubber-duck follow-up to issue #2224: an anonymous-class literal's
        // synthesized type exposes get-only auto-properties, not plain fields
        // (see AnonymousTypeCache); its runtime storage in Fields lives under
        // the property's backing-field name. Ordinary structs/classes keep
        // Fields non-empty and are unaffected.
        private func GetDisplayMembers(type StructSymbol) sequence[(DisplayName string, StorageKey string)] {
            if !type.Fields.IsDefaultOrEmpty {
                for field in type.Fields {
                    yield(field.Name, field.Name)
                }
                yield break
            }
            for property in type.Properties {
                if property.IsAutoProperty && property.BackingField != nil {
                    yield(property.Name, property.BackingField!!.Name)
                }
            }
        }
    }
}
