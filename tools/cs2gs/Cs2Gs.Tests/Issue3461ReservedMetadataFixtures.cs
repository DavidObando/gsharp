// <copyright file="Issue3461ReservedMetadataFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace @class
{
    /// <summary>Imported reserved-name type.</summary>
    public sealed class @type
    {
        /// <summary>Gets fixture value.</summary>
        public int Value => 19;
    }

    /// <summary>Imported legal colliding type.</summary>
    public sealed class type_
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
