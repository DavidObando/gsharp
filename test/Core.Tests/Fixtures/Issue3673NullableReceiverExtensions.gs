// <copyright file="Issue3673NullableReceiverExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import System

/// Issue #3673 fixture: mirrors the shape of
/// `Gsharp.Extensions.Optional.OrThrow` — an imported generic extension
/// method whose only inference site for `T` is a `Nullable<T>`
/// `this` parameter, plus a sibling whose ordinary argument also mentions
/// `T`. Calling the former with instance syntax on a value-typed nullable
/// receiver must infer `T` from the receiver alone.
shared class Issue3673NullableReceiverExtensions { }

/// Unwraps a present value or throws; `T` is inferable only from the receiver.
/// @typeparam T The underlying value type.
/// @param message The exception message used when the receiver has no value.
/// @returns The receiver's value when present.
@ExtensionOwner(typeof(Issue3673NullableReceiverExtensions))
func (self T?) UnwrapOrThrow3673[T struct](message string) T -> self ?? throw InvalidOperationException(message)

/// Unwraps a present reference or throws; `T` is inferable only from the receiver.
/// @typeparam T The underlying reference type.
/// @param message The exception message used when the receiver is null.
/// @returns The receiver's value when present.
@ExtensionOwner(typeof(Issue3673NullableReceiverExtensions))
func (self T) UnwrapOrThrow3673[T class](message string) T -> self ?? throw InvalidOperationException(message)

/// Returns the receiver's value, or [`fallback`](paramref); `T` is also inferable from the argument.
/// @typeparam T The underlying value type.
/// @param fallback The value returned when the receiver has no value.
/// @returns The receiver's value when present, otherwise [`fallback`](paramref).
@ExtensionOwner(typeof(Issue3673NullableReceiverExtensions))
func (self T?) UnwrapOrElse3673[T struct](fallback T) T -> self ?? fallback

/// Takes the underlying value type directly, so a nullable receiver must not match it.
/// @returns The receiver, doubled.
@ExtensionOwner(typeof(Issue3673NullableReceiverExtensions))
func (self int32) Double3673() int32 -> self * 2
