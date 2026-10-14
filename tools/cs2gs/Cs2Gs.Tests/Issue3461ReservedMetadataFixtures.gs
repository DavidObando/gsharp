// <copyright file="Issue3461ReservedMetadataFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package $class

/// Imported reserved-name defer.
class $defer {
    /// Gets fixture value.
    prop Value int32 -> 19
}

/// Imported legal colliding defer.
class defer_ {
    /// Gets fixture value.
    prop Value int32 -> 23
}
