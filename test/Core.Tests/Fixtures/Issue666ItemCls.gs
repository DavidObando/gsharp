// <copyright file="Issue666ItemCls.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

/// Issue #666 fixture: a simple CLR reference type from a "project reference"
/// assembly. When this assembly is supplied via `/reference:` (or loaded
/// through (cref:System.Reflection.MetadataLoadContext) in a binder
/// test), using `ItemCls` as the element type of a generic collection
/// and then calling LINQ extension methods with instance syntax must succeed.
class Issue666ItemCls {
    private var _name string = string.Empty

    prop Name string {
        get {
            return _name
        }
        set {
            _name = value
        }
    }
}
