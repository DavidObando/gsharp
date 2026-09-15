import type {ComponentProps} from 'react';
import Components from '@theme-original/MDXComponents';
import type {MDXComponentsObject} from '@theme/MDXComponents';

// Preserve search-token boundaries in minified tables: GS0154 + Error must not become GS0154Error.
const components: MDXComponentsObject = {
  ...Components,
  td: ({children, ...props}: ComponentProps<'td'>) => (
    <td
      {...props}
      data-pagefind-weight={
        typeof children === 'string' && /^GS\d{4}$/.test(children) ? '10' : undefined
      }>
      {children}
      {'\u00a0'}
    </td>
  ),
  th: ({children, ...props}: ComponentProps<'th'>) => (
    <th {...props}>
      {children}
      {'\u00a0'}
    </th>
  ),
};

export default components;
