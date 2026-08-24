// <copyright file="Issue3461ReservedMetadataFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace @class
{
    /// <summary>Imported reserved-name defer.</summary>
    public sealed class @defer
    {
        /// <summary>Gets fixture value.</summary>
        public int Value => 19;
    }

    /// <summary>Imported legal colliding defer.</summary>
    public sealed class defer_
    {
        /// <summary>Gets fixture value.</summary>
        public int Value => 23;
    }
}

namespace class_
{
    /// <summary>Legal colliding namespace marker.</summary>
    public sealed class Marker
    {
    }
}

namespace ImportedVisible
{
    /// <summary>Imported namespace-visible defer used by generic scope tests.</summary>
    public sealed class defer_
    {
    }
}
