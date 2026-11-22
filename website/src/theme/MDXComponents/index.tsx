import {useEffect, useRef, type ComponentProps} from 'react';
import Components from '@theme-original/MDXComponents';
import type {MDXComponentsObject} from '@theme/MDXComponents';

function Table({children, ...props}: ComponentProps<'table'>) {
  const ref = useRef<HTMLTableElement>(null);
  useEffect(() => {
    const table = ref.current;
    if (!table || props.tabIndex !== undefined) return;
    const update = () => {
      if (table.scrollWidth > table.clientWidth || table.scrollHeight > table.clientHeight) {
        table.tabIndex = 0;
      } else {
        table.removeAttribute('tabindex');
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(table);
    return () => observer.disconnect();
  }, [props.tabIndex]);
  return <table {...props} ref={ref}>{children}</table>;
}

// Preserve search-token boundaries in minified tables: GS0154 + Error must not become GS0154Error.
const components: MDXComponentsObject = {
  ...Components,
  table: Table,
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
