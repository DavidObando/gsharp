// <copyright file="Issue2822LegalEnumerable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System.Collections.Generic

/// Legal CLR shape with generic and non-generic zero-argument overloads.
class Issue2822LegalEnumerable {
    /// Gets the pattern enumerator.
    func GetEnumerator() List[int32].Enumerator -> List[int32]().GetEnumerator()

    /// Generic overload that must not participate in the enumeration pattern.
    func GetEnumerator[T]() List[int32].Enumerator -> GetEnumerator()
}
