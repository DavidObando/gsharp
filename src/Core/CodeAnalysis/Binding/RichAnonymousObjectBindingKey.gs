// <copyright file="RichAnonymousObjectBindingKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System

internal data struct RichAnonymousObjectBindingKey(Type StructSymbol, Function FunctionSymbol?) : IEquatable[
    RichAnonymousObjectBindingKey
] { }
