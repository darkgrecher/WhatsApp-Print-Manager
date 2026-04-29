'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Layout,
  Tabs,
  Table,
  Button,
  Tag,
  Space,
  Typography,
  message,
  Popconfirm,
  Card,
  Statistic,
  Row,
  Col,
  Badge,
  Input,
  Modal,
  Form,
  Select,
} from 'antd';
import {
  UserOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  LogoutOutlined,
  WhatsAppOutlined,
  CrownOutlined,
  ExperimentOutlined,
  SearchOutlined,
  PlusOutlined,
  SwapOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  getUsersApi,
  getActiveUsersApi,
  activateUserApi,
  deactivateUserApi,
  deleteUserApi,
  createUserApi,
  changePlanApi,
  getSettingsApi,
  updateSettingApi,
} from '@/lib/api';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';

const { Header, Content } = Layout;
const { Title } = Typography;

const POLL_INTERVAL = 5000; // 5 seconds

interface User {
  id: number;
  phoneNumber: string;
  displayName: string | null;
  status: string;
  planType: string | null;
  planStartDate: string | null;
  planEndDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function DashboardPage() {
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [activeUsers, setActiveUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('trial-requests');
  const [searchText, setSearchText] = useState('');
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserLoading, setAddUserLoading] = useState(false);
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const [changePlanUser, setChangePlanUser] = useState<User | null>(null);
  const [changePlanLoading, setChangePlanLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [adminContact, setAdminContact] = useState('');
  const [addUserForm] = Form.useForm();
  const [changePlanForm] = Form.useForm();
  const [settingsForm] = Form.useForm();
  const router = useRouter();
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [allRes, activeRes] = await Promise.all([
        getUsersApi(),
        getActiveUsersApi(),
      ]);
      setAllUsers(allRes.data);
      setActiveUsers(activeRes.data);
    } catch (err) {
      if (!silent) message.error('Failed to fetch data');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // ── Initial load + real-time polling ──
  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      router.push('/');
      return;
    }
    fetchData();

    // Load settings
    loadSettings();

    // Start auto-polling
    pollingRef.current = setInterval(() => {
      fetchData(true); // silent refresh — no loading spinner
    }, POLL_INTERVAL);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [fetchData, router]);

  const loadSettings = async () => {
    try {
      const res = await getSettingsApi();
      const data = res.data;
      if (data.admin_contact_number) {
        setAdminContact(data.admin_contact_number);
      }
    } catch (err) {
      // ignore
    }
  };

  const openSettings = () => {
    settingsForm.setFieldsValue({ adminContactNumber: adminContact });
    setSettingsOpen(true);
  };

  const handleSaveSettings = async () => {
    try {
      const values = await settingsForm.validateFields();
      setSettingsLoading(true);
      await updateSettingApi('admin_contact_number', values.adminContactNumber || '');
      setAdminContact(values.adminContactNumber || '');
      message.success('Settings saved');
      setSettingsOpen(false);
    } catch (err: any) {
      if (!err?.errorFields) message.error('Failed to save settings');
    } finally {
      setSettingsLoading(false);
    }
  };

  // ── Filter helper ──
  const filterUsers = useCallback(
    (users: User[]) => {
      if (!searchText.trim()) return users;
      const q = searchText.toLowerCase();
      return users.filter(
        (u) =>
          u.phoneNumber.toLowerCase().includes(q) ||
          (u.displayName && u.displayName.toLowerCase().includes(q)),
      );
    },
    [searchText],
  );

  const filteredActive = useMemo(() => filterUsers(activeUsers), [filterUsers, activeUsers]);
  const filteredAll = useMemo(() => filterUsers(allUsers), [filterUsers, allUsers]);
  const trialRequests = useMemo(
    () => activeUsers.filter((u) => u.planType === 'TRIAL'),
    [activeUsers],
  );
  const expiredTrials = useMemo(
    () => allUsers.filter((u) => u.status === 'EXPIRED' && u.planType === 'TRIAL'),
    [allUsers],
  );
  const filteredTrialRequests = useMemo(
    () => filterUsers(trialRequests),
    [filterUsers, trialRequests],
  );
  const filteredExpiredTrials = useMemo(
    () => filterUsers(expiredTrials),
    [filterUsers, expiredTrials],
  );

  // ── Handlers ──
  const handleActivate = async (id: number, planType: 'TRIAL' | 'ANNUAL') => {
    try {
      await activateUserApi(id, planType);
      message.success(
        `${planType === 'TRIAL' ? 'Trial (7 days)' : 'Annual plan'} activated successfully`,
      );
      fetchData();
    } catch (err) {
      message.error('Failed to activate plan');
    }
  };

  const handleDeactivate = async (id: number) => {
    try {
      await deactivateUserApi(id);
      message.success('User deactivated');
      fetchData();
    } catch (err) {
      message.error('Failed to deactivate');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteUserApi(id);
      message.success('User deleted');
      fetchData();
    } catch (err) {
      message.error('Failed to delete');
    }
  };

  const handleAddUser = async () => {
    try {
      const values = await addUserForm.validateFields();
      setAddUserLoading(true);
      await createUserApi({
        phoneNumber: values.phoneNumber,
        displayName: values.displayName || undefined,
        planType: values.planType || undefined,
      });
      message.success('User added successfully');
      setAddUserOpen(false);
      addUserForm.resetFields();
      fetchData();
    } catch (err: any) {
      if (err?.response?.data?.message) {
        message.error(err.response.data.message);
      } else if (err?.errorFields) {
        // form validation error — ignore
      } else {
        message.error('Failed to add user');
      }
    } finally {
      setAddUserLoading(false);
    }
  };

  const openChangePlan = (user: User) => {
    setChangePlanUser(user);
    changePlanForm.setFieldsValue({ planType: user.planType || 'TRIAL' });
    setChangePlanOpen(true);
  };

  const handleChangePlan = async () => {
    if (!changePlanUser) return;
    try {
      const values = await changePlanForm.validateFields();
      setChangePlanLoading(true);
      await changePlanApi(changePlanUser.id, values.planType);
      message.success('Plan changed successfully — dates auto-updated');
      setChangePlanOpen(false);
      fetchData();
    } catch (err) {
      message.error('Failed to change plan');
    } finally {
      setChangePlanLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('admin_token');
    router.push('/');
  };

  // ── Tag renderers ──
  const getStatusTag = (status: string) => {
    const map: Record<string, { color: string; icon: React.ReactNode }> = {
      PENDING: { color: 'orange', icon: <ClockCircleOutlined /> },
      ACTIVE: { color: 'green', icon: <CheckCircleOutlined /> },
      EXPIRED: { color: 'red', icon: <StopOutlined /> },
      REJECTED: { color: 'default', icon: <StopOutlined /> },
    };
    const { color, icon } = map[status] || { color: 'default', icon: null };
    return (
      <Tag color={color} icon={icon}>
        {status}
      </Tag>
    );
  };

  const getPlanTag = (planType: string | null) => {
    if (!planType) return <Tag>—</Tag>;
    if (planType === 'TRIAL')
      return (
        <Tag color="blue" icon={<ExperimentOutlined />}>
          Trial
        </Tag>
      );
    return (
      <Tag color="purple" icon={<CrownOutlined />}>
        Annual
      </Tag>
    );
  };

  // ── Columns for "Active Users" tab ──
  const activeColumns = [
    {
      title: 'Phone Number',
      dataIndex: 'phoneNumber',
      key: 'phoneNumber',
      render: (phone: string) => (
        <span style={{ fontWeight: 500 }}>+{phone}</span>
      ),
    },
    {
      title: 'Display Name',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (name: string | null) => name || '—',
    },
    {
      title: 'Plan',
      dataIndex: 'planType',
      key: 'planType',
      render: (planType: string | null) => getPlanTag(planType),
    },
    {
      title: 'Start Date',
      dataIndex: 'planStartDate',
      key: 'planStartDate',
      render: (date: string | null) =>
        date ? dayjs(date).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'End Date',
      dataIndex: 'planEndDate',
      key: 'planEndDate',
      render: (date: string | null) =>
        date ? dayjs(date).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: User) => (
        <Space>
          <Button
            size="small"
            icon={<SwapOutlined />}
            onClick={() => openChangePlan(record)}
          >
            Change Plan
          </Button>
          <Popconfirm
            title="Deactivate this user?"
            onConfirm={() => handleDeactivate(record.id)}
          >
            <Button danger size="small" icon={<StopOutlined />}>
              Deactivate
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const expiredTrialColumns = [
    {
      title: 'Phone Number',
      dataIndex: 'phoneNumber',
      key: 'phoneNumber',
      render: (phone: string) => (
        <span style={{ fontWeight: 500 }}>+{phone}</span>
      ),
    },
    {
      title: 'Display Name',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (name: string | null) => name || '—',
    },
    {
      title: 'Plan',
      dataIndex: 'planType',
      key: 'planType',
      render: (planType: string | null) => getPlanTag(planType),
    },
    {
      title: 'Expired On',
      dataIndex: 'planEndDate',
      key: 'planEndDate',
      render: (date: string | null) =>
        date ? dayjs(date).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: User) => (
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<ExperimentOutlined />}
            onClick={() => handleActivate(record.id, 'TRIAL')}
          >
            Trial (7 days)
          </Button>
          <Button
            size="small"
            icon={<CrownOutlined />}
            style={{ borderColor: '#722ed1', color: '#722ed1' }}
            onClick={() => handleActivate(record.id, 'ANNUAL')}
          >
            Annual Plan
          </Button>
          <Popconfirm
            title="Delete this user permanently?"
            onConfirm={() => handleDelete(record.id)}
          >
            <Button danger size="small" icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // ── Columns for "All Users" tab ──
  const allColumns = [
    {
      title: 'Phone Number',
      dataIndex: 'phoneNumber',
      key: 'phoneNumber',
      render: (phone: string) => (
        <span style={{ fontWeight: 500 }}>+{phone}</span>
      ),
    },
    {
      title: 'Display Name',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (name: string | null) => name || '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => getStatusTag(status),
      filters: [
        { text: 'Pending', value: 'PENDING' },
        { text: 'Active', value: 'ACTIVE' },
        { text: 'Expired', value: 'EXPIRED' },
        { text: 'Rejected', value: 'REJECTED' },
      ],
      onFilter: (value: any, record: User) => record.status === value,
    },
    {
      title: 'Plan',
      dataIndex: 'planType',
      key: 'planType',
      render: (planType: string | null) => getPlanTag(planType),
    },
    {
      title: 'Start Date',
      dataIndex: 'planStartDate',
      key: 'planStartDate',
      render: (date: string | null) =>
        date ? dayjs(date).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'End Date',
      dataIndex: 'planEndDate',
      key: 'planEndDate',
      render: (date: string | null) =>
        date ? dayjs(date).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: User) => (
        <Space>
          {record.status !== 'ACTIVE' && (
            <>
              <Button
                type="primary"
                size="small"
                icon={<ExperimentOutlined />}
                onClick={() => handleActivate(record.id, 'TRIAL')}
              >
                Trial
              </Button>
              <Button
                size="small"
                icon={<CrownOutlined />}
                style={{ borderColor: '#722ed1', color: '#722ed1' }}
                onClick={() => handleActivate(record.id, 'ANNUAL')}
              >
                Annual
              </Button>
            </>
          )}
          {record.status === 'ACTIVE' && (
            <>
              <Button
                size="small"
                icon={<SwapOutlined />}
                onClick={() => openChangePlan(record)}
              >
                Change Plan
              </Button>
              <Popconfirm
                title="Deactivate this user?"
                onConfirm={() => handleDeactivate(record.id)}
              >
                <Button danger size="small" icon={<StopOutlined />}>
                  Deactivate
                </Button>
              </Popconfirm>
            </>
          )}
          <Popconfirm
            title="Delete this user permanently?"
            onConfirm={() => handleDelete(record.id)}
          >
            <Button danger size="small" icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const expiredTrialsCount = expiredTrials.length;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          background: '#fff',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid #f0f0f0',
          boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        }}
      >
        <Space>
          <WhatsAppOutlined style={{ fontSize: 24, color: '#25D366' }} />
          <Title level={4} style={{ margin: 0 }}>
            WhatsApp Print Manager — Admin
          </Title>
        </Space>
        <Space>
          <Button
            icon={<SettingOutlined />}
            onClick={openSettings}
          />
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>
            Logout
          </Button>
        </Space>
      </Header>

      <Content style={{ padding: 24, background: '#f5f5f5' }}>
        {/* Stats Cards */}
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic
                title="Total Users"
                value={allUsers.length}
                prefix={<UserOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic
                title="Trial Requests"
                value={trialRequests.length}
                valueStyle={{ color: '#fa8c16' }}
                prefix={<ClockCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic
                title="Active Users"
                value={activeUsers.length}
                valueStyle={{ color: '#25D366' }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic
                title="Expired Trials"
                value={expiredTrialsCount}
                valueStyle={{ color: '#ff4d4f' }}
                prefix={<StopOutlined />}
              />
            </Card>
          </Col>
        </Row>

        {/* Search + Add User */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col flex="auto">
            <Input
              placeholder="Search by phone number or display name..."
              prefix={<SearchOutlined />}
              allowClear
              size="large"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </Col>
          <Col>
            <Button
              type="primary"
              size="large"
              icon={<PlusOutlined />}
              onClick={() => setAddUserOpen(true)}
            >
              Add User
            </Button>
          </Col>
        </Row>

        {/* Tabs with Tables */}
        <Card bordered={false}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: 'trial-requests',
                label: (
                  <Badge
                    count={filteredTrialRequests.length}
                    offset={[10, 0]}
                    size="small"
                  >
                    <span>New Trial Requests</span>
                  </Badge>
                ),
                children: (
                  <Table
                    columns={activeColumns}
                    dataSource={filteredTrialRequests}
                    rowKey="id"
                    loading={loading}
                    pagination={{ pageSize: 10 }}
                    locale={{ emptyText: 'No trial requests' }}
                  />
                ),
              },
              {
                key: 'expired-trials',
                label: `Expired Trials (${filteredExpiredTrials.length})`,
                children: (
                  <Table
                    columns={expiredTrialColumns}
                    dataSource={filteredExpiredTrials}
                    rowKey="id"
                    loading={loading}
                    pagination={{ pageSize: 10 }}
                    locale={{ emptyText: 'No expired trials' }}
                  />
                ),
              },
              {
                key: 'active',
                label: `Active Users (${filteredActive.length})`,
                children: (
                  <Table
                    columns={activeColumns}
                    dataSource={filteredActive}
                    rowKey="id"
                    loading={loading}
                    pagination={{ pageSize: 10 }}
                    locale={{ emptyText: 'No active users' }}
                  />
                ),
              },
              {
                key: 'all',
                label: `All Users (${filteredAll.length})`,
                children: (
                  <Table
                    columns={allColumns}
                    dataSource={filteredAll}
                    rowKey="id"
                    loading={loading}
                    pagination={{ pageSize: 10 }}
                    locale={{ emptyText: 'No users found' }}
                  />
                ),
              },
            ]}
          />
        </Card>
      </Content>

      {/* ── Add User Modal ── */}
      <Modal
        title="Add New User"
        open={addUserOpen}
        onOk={handleAddUser}
        onCancel={() => {
          setAddUserOpen(false);
          addUserForm.resetFields();
        }}
        confirmLoading={addUserLoading}
        okText="Add User"
      >
        <Form form={addUserForm} layout="vertical">
          <Form.Item
            name="phoneNumber"
            label="Phone Number"
            rules={[{ required: true, message: 'Phone number is required' }]}
          >
            <Input placeholder="e.g. 94771234567 (without +)" />
          </Form.Item>
          <Form.Item name="displayName" label="Display Name">
            <Input placeholder="Optional display name" />
          </Form.Item>
          <Form.Item name="planType" label="Plan (optional — activates immediately)">
            <Select allowClear placeholder="Leave empty for Pending status">
              <Select.Option value="TRIAL">Trial (7 days)</Select.Option>
              <Select.Option value="ANNUAL">Annual (1 year)</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Change Plan Modal ── */}
      <Modal
        title={
          changePlanUser
            ? `Change Plan — +${changePlanUser.phoneNumber}`
            : 'Change Plan'
        }
        open={changePlanOpen}
        onOk={handleChangePlan}
        onCancel={() => setChangePlanOpen(false)}
        confirmLoading={changePlanLoading}
        okText="Update Plan"
      >
        <p style={{ color: '#888', marginBottom: 16 }}>
          Changing the plan will reset start date to <strong>today</strong> and
          auto-calculate the new end date.
        </p>
        <Form form={changePlanForm} layout="vertical">
          <Form.Item
            name="planType"
            label="New Plan"
            rules={[{ required: true, message: 'Select a plan' }]}
          >
            <Select>
              <Select.Option value="TRIAL">Trial (7 days)</Select.Option>
              <Select.Option value="ANNUAL">Annual (1 year)</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Settings Modal ── */}
      <Modal
        title={
          <Space>
            <SettingOutlined />
            <span>Settings</span>
          </Space>
        }
        open={settingsOpen}
        onOk={handleSaveSettings}
        onCancel={() => setSettingsOpen(false)}
        confirmLoading={settingsLoading}
        okText="Save"
      >
        <Form form={settingsForm} layout="vertical">
          <Form.Item
            name="adminContactNumber"
            label="Admin Contact Number"
            extra="This number will be shown in the Whatsapp-print-manager application as 'Contact Administration'. Enter without the + prefix (e.g. 94771234567)."
          >
            <Input placeholder="e.g. 94771234567" />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
