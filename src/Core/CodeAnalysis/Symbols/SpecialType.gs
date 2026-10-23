// <copyright file="SpecialType.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// Tags the types that the compiler names itself (ADR-0209 section 5, "Well-known types").
/// A (cref:WellKnownTypes) table resolves each tagged type by name in the reference set.
internal enum SpecialType {
    None,
    Object,
    Void,
    Boolean,
    Char,
    SByte,
    Byte,
    Int16,
    UInt16,
    Int32,
    UInt32,
    Int64,
    UInt64,
    IntPtr,
    UIntPtr,
    Single,
    Double,
    Decimal,
    String,
    ValueType,
    Enum,
    Delegate,
    MulticastDelegate,
    Array,
    Nullable,
    ValueTuple1,
    ValueTuple2,
    ValueTuple3,
    ValueTuple4,
    ValueTuple5,
    ValueTuple6,
    ValueTuple7,
    ValueTuple8
}
