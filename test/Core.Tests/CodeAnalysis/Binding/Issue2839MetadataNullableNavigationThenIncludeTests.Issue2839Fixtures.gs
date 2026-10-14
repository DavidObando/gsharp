// <copyright file="Issue2839MetadataNullableNavigationThenIncludeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding.Issue2839Fixtures

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

class Leaf2839 {
    prop Name string?
}

class Child2839 {
    prop Leaf Leaf2839?
}

class Entity2839 {
    init() {
        NullableChildren = List[Child2839]()
        Children = List[Child2839]()
        NullableList = List[Child2839]()
    }

    prop Conversion Leaf2839?

    prop NullableChildren ICollection[Child2839]? {
        get;
    }

    prop Children ICollection[Child2839] {
        get;
    }

    prop NullableList List[Child2839]? {
        get;
    }
}
